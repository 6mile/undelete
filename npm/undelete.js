#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

const REGISTRIES = [
    "https://registry.npmjs.org/",
    "https://r.cnpmjs.org/",
    "https://registry.npmmirror.com/",
    "https://repo.huaweicloud.com/repository/npm/",
    "https://mirrors.cloud.tencent.com/npm/"
];

const VERSION = "1.1.7";

let SILENT_MODE = false;

function log(...args) {
    if (!SILENT_MODE) {
        console.log(...args);
    }
}

function showBanner() {
    if (SILENT_MODE) return;
    
    console.log(`
                   __     __     __     
  __  ______  ____/ /__  / /__  / /____ 
 / / / / __ \\/ __  / _ \\/ / _ \\/ __/ _ \\
/ /_/ / / / / /_/ /  __/ /  __/ /_/  __/
\\__,_/_/ /_/\\__,_/\\___/_/\\___/\\__/\\___/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 NPM Package Recovery Tool v${VERSION}
 Created by 6mile - github.com/6mile
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

function showHelp() {
    console.log(`
                   __     __     __     
  __  ______  ____/ /__  / /__  / /____ 
 / / / / __ \\/ __  / _ \\/ / _ \\/ __/ _ \\
/ /_/ / / / / /_/ /  __/ /  __/ /_/  __/
\\__,_/_/ /_/\\__,_/\\___/_/\\___/\\__/\\___/

NPM Package Recovery Tool v${VERSION}
Created by 6mile - github.com/6mile

USAGE:
  undelete <package-name> [options]

OPTIONS:
  -n, --number <count>      Number of versions to download (1-20, default: 5)
  
  -p, --path <directory>    Save downloaded packages to specified directory
                            (default: current directory)
  
  -d, --data                Get package metadata (NPM user and email) instead
                            of downloading files
  
  -s, --silent              Run in silent mode with no output
  
  -h, --help                Display this help message

  -v, --version             Show the version of undelete

EXAMPLES:
  undelete express
  undelete @angular/core -n 10
  undelete lodash --path ./downloads
  undelete react -p /tmp/packages -n 15 -s
  undelete express --data

DESCRIPTION:
  Downloads the most recent versions of any NPM package from multiple
  registry mirrors with automatic failover and retry logic.

REGISTRIES (checked in order):
  1. https://registry.npmjs.org/
  2. https://r.cnpmjs.org/
  3. https://registry.npmmirror.com/
  4. https://repo.huaweicloud.com/repository/npm/
  5. https://mirrors.cloud.tencent.com/npm/

NOTES:
  - Security placeholder packages (0.0.1-security.tgz) are skipped
  - Tencent mirror may require up to 10 retry attempts
  - Exit code 0 on success, 1 on failure
`);
    process.exit(0);
}

async function getPackageInfo(registry, packageName, isTencent = false) {
    const maxAttempts = isTencent ? 10 : 1;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const packageData = await fetchPackageData(registry, packageName, attempt, maxAttempts, isTencent);
        
        if (!packageData) {
            if (attempt < maxAttempts && isTencent) {
                log(`  [Tencent] Retrying metadata fetch (${attempt}/${maxAttempts})...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            return null;
        }
        
        if (isTencent && packageData.versions) {
            const versions = Object.values(packageData.versions);
            const allSecurity = versions.every(v => {
                return v.dist && v.dist.tarball && v.dist.tarball.endsWith('0.0.1-security.tgz');
            });
            
            if (allSecurity && attempt < maxAttempts) {
                log(`  [Tencent] Only security placeholders found (attempt ${attempt}/${maxAttempts}), retrying...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
        }
        
        return packageData;
    }
    
    if (isTencent) {
        log(`  [Tencent] All ${maxAttempts} metadata fetch attempts exhausted`);
    }
    return null;
}

function fetchPackageData(registry, packageName, attempt, maxAttempts, isTencent) {
    return new Promise((resolve) => {
        const url = `${registry}${encodeURIComponent(packageName)}`;
        const protocol = url.startsWith('https') ? https : http;

        if (isTencent) {
            log(`  [Tencent] Fetching package metadata (attempt ${attempt}/${maxAttempts})...`);
        }

        const request = protocol.get(url, { timeout: 10000 }, (response) => {
            if (response.statusCode === 200) {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        log(`  Error parsing JSON from ${registry}`);
                        resolve(null);
                    }
                });
            } else if (response.statusCode === 404) {
                log(`  Package not found in ${registry}`);
                resolve(null);
            } else {
                log(`  Error ${response.statusCode} from ${registry}`);
                resolve(null);
            }
        });

        request.on('error', (e) => {
            if (isTencent) {
                log(`  [Tencent] Connection error (attempt ${attempt}/${maxAttempts}): ${e.message}`);
            } else {
                log(`  Connection error with ${registry}: ${e.message}`);
            }
            resolve(null);
        });

        request.on('timeout', () => {
            request.destroy();
            if (isTencent) {
                log(`  [Tencent] Timeout (attempt ${attempt}/${maxAttempts})`);
            } else {
                log(`  Timeout connecting to ${registry}`);
            }
            resolve(null);
        });
    });
}

function compareVersions(a, b) {
    const aParts = a.split(/[.-]/).map(p => isNaN(p) ? p : parseInt(p));
    const bParts = b.split(/[.-]/).map(p => isNaN(p) ? p : parseInt(p));
    
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aPart = aParts[i] ?? 0;
        const bPart = bParts[i] ?? 0;
        
        if (typeof aPart === 'number' && typeof bPart === 'number') {
            if (aPart !== bPart) return bPart - aPart;
        } else {
            const aStr = String(aPart);
            const bStr = String(bPart);
            if (aStr !== bStr) return bStr.localeCompare(aStr);
        }
    }
    return 0;
}

function getLastVersions(packageData, count) {
    if (!packageData || !packageData.versions) {
        return [];
    }

    try {
        const versions = Object.keys(packageData.versions);
        versions.sort(compareVersions);
        const selected = versions.slice(0, count);
        
        const versionInfo = [];
        for (const version of selected) {
            const versionData = packageData.versions[version];
            const tarballUrl = versionData && versionData.dist && versionData.dist.tarball;
            
            if (tarballUrl) {
                versionInfo.push({ version, url: tarballUrl });
            }
        }
        
        return versionInfo;
    } catch (e) {
        log(`  Error parsing package data: ${e.message}`);
        return [];
    }
}

async function downloadPackage(url, packageName, version, outputPath, isTencent = false) {
    const maxAttempts = isTencent ? 10 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (isTencent) {
                log(`[Tencent] Downloading ${packageName}@${version} (attempt ${attempt}/${maxAttempts})...`);
            } else if (attempt === 1) {
                log(`Downloading ${packageName}@${version}...`);
            }

            const success = await performDownload(url, packageName, version, outputPath);
            if (success) {
                if (isTencent && attempt > 1) {
                    log(`  Succeeded after ${attempt} attempts`);
                }
                return true;
            }

            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (e) {
            if (isTencent) {
                log(`  Attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
            } else {
                log(`Download failed: ${e.message}`);
            }
        }
    }

    if (isTencent) {
        log(`All ${maxAttempts} attempts failed for ${packageName}@${version}`);
    }

    return false;
}

function performDownload(url, packageName, version, outputPath) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        const filename = `${packageName.replace('/', '-')}-${version}.tgz`;
        const filepath = path.join(outputPath, filename);

        const request = protocol.get(url, { timeout: 30000 }, (response) => {
            if (response.statusCode === 200) {
                const fileStream = fs.createWriteStream(filepath);

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    log(`Successfully downloaded to ${filepath}`);
                    resolve(true);
                });

                fileStream.on('error', (e) => {
                    fs.unlink(filepath, () => {});
                    reject(e);
                });
            } else {
                reject(new Error(`HTTP ${response.statusCode}`));
            }
        });

        request.on('error', reject);

        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

async function getPackageMetadata(registry, packageName, isTencent = false) {
    const maxAttempts = isTencent ? 10 : 1;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (isTencent && attempt > 1) {
                log(`  [Tencent] Retry attempt ${attempt}/${maxAttempts}...`);
            }
            
            const registryUrl = registry.replace(/\/$/, '');
            const { stdout } = await execPromise(
                `npm view ${packageName} --json --registry ${registryUrl} 2>/dev/null`,
                { timeout: 30000 }
            );
            
            if (!stdout) {
                throw new Error('No output from npm view');
            }
            
            const data = JSON.parse(stdout);
            
            // Parse _npmUser which can be a string like "name <email>" or an object
            let npmUser = null;
            if (data._npmUser) {
                if (typeof data._npmUser === 'string') {
                    const match = data._npmUser.match(/^(.+?)\s*<(.+?)>$/);
                    if (match) {
                        npmUser = { name: match[1].trim(), email: match[2].trim() };
                    } else {
                        npmUser = { name: data._npmUser, email: null };
                    }
                } else if (typeof data._npmUser === 'object') {
                    npmUser = data._npmUser;
                }
            }
            
            return {
                name: data.name,
                version: data.version,
                description: data.description || '',
                npmUser: npmUser,
                maintainers: data.maintainers || [],
                author: data.author || {}
            };
        } catch (e) {
            if (isTencent && attempt < maxAttempts) {
                log(`  [Tencent] Attempt ${attempt}/${maxAttempts} failed`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else if (attempt >= maxAttempts) {
                log(`  Package not found in this registry`);
                return null;
            }
        }
    }
    
    return null;
}

async function displayPackageData(packageName) {
    showBanner();
    
    log(`Fetching package metadata for: ${packageName}\n`);
    
    for (const registry of REGISTRIES) {
        log(`Checking ${registry}...`);
        
        const isTencent = registry.includes('tencent.com');
        const metadata = await getPackageMetadata(registry, packageName, isTencent);
        
        if (!metadata) {
            continue;
        }
        
        if (metadata.version && metadata.version.endsWith('0.0.1-security')) {
            log(`  Skipping security placeholder version: ${metadata.version}\n`);
            continue;
        }
        
        const hasSecurityEmail = (email) => email && email === 'npm@npmjs.com';
        
        const npmUserHasSecurityEmail = metadata.npmUser && hasSecurityEmail(metadata.npmUser.email);
        const authorHasSecurityEmail = metadata.author && hasSecurityEmail(metadata.author.email);
        const allMaintainersHaveSecurityEmail = Array.isArray(metadata.maintainers) && 
            metadata.maintainers.length > 0 &&
            metadata.maintainers.every(m => hasSecurityEmail(m.email));
        
        if (npmUserHasSecurityEmail || authorHasSecurityEmail || allMaintainersHaveSecurityEmail) {
            log(`  Skipping package with security placeholder email\n`);
            continue;
        }
        
        if (SILENT_MODE) {
            const jsonOutput = {
                package: metadata.name,
                version: metadata.version,
                description: metadata.description,
                npmUser: metadata.npmUser && metadata.npmUser.name || null,
                npmUserEmail: metadata.npmUser && metadata.npmUser.email || null,
                maintainers: metadata.maintainers || []
            };
            console.log(JSON.stringify(jsonOutput, null, 2));
            process.exit(0);
        }
        
        log(`\nPackage: ${metadata.name}`);
        log(`Version: ${metadata.version}`);
        if (metadata.description) {
            log(`Description: ${metadata.description}`);
        }
        log('');
        
        if (metadata.npmUser && Object.keys(metadata.npmUser).length > 0) {
            log(`NPM User:`);
            if (metadata.npmUser.name) log(`  Name: ${metadata.npmUser.name}`);
            if (metadata.npmUser.email) log(`  Email: ${metadata.npmUser.email}`);
            log('');
        }
        
        if (metadata.author && Object.keys(metadata.author).length > 0) {
            log(`Author:`);
            if (metadata.author.name) log(`  Name: ${metadata.author.name}`);
            if (metadata.author.email) log(`  Email: ${metadata.author.email}`);
            log('');
        }
        
        if (Array.isArray(metadata.maintainers) && metadata.maintainers.length > 0) {
            log(`Maintainers:`);
            metadata.maintainers.forEach((maintainer, index) => {
                log(`  ${index + 1}. ${maintainer.name || 'N/A'}`);
                if (maintainer.email) log(`     Email: ${maintainer.email}`);
            });
            log('');
        }
        
        log(`Data retrieved from: ${registry}`);
        process.exit(0);
    }
    
    log("\nFailed to retrieve package metadata from any registry");
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    let packageName = null;
    let outputPath = process.cwd();
    let versionCount = 5;
    let dataMode = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--help' || args[i] === '-h') {
            showHelp();
        } else if (args[i] === '--version' || args[i] === '-v') {
            console.log(`v${VERSION}`);
            process.exit(0);
        } else if (args[i] === '--data' || args[i] === '-d') {
            dataMode = true;
        } else if (args[i] === '--number' || args[i] === '-n') {
            if (i + 1 < args.length) {
                const count = parseInt(args[i + 1]);
                if (isNaN(count) || count < 1 || count > 20) {
                    console.log("Error: --number/-n must be between 1 and 20");
                    process.exit(1);
                }
                versionCount = count;
                i++;
            } else {
                console.log("Error: --number/-n requires a count (1-20)");
                process.exit(1);
            }
        } else if (args[i] === '--path' || args[i] === '-p') {
            if (i + 1 < args.length) {
                outputPath = args[i + 1];
                i++;
            } else {
                console.log("Error: --path/-p requires a directory path");
                process.exit(1);
            }
        } else if (args[i] === '--silent' || args[i] === '-s') {
            SILENT_MODE = true;
        } else if (!packageName) {
            packageName = args[i];
        }
    }

    if (!packageName) {
        console.log("Usage: undelete <package-name> [--number|-n <count>] [--path|-p <directory>] [--data|-d] [--silent|-s]");
        console.log("Try 'undelete --help' for more information.");
        process.exit(1);
    }

    if (dataMode) {
        await displayPackageData(packageName);
        return;
    }

    if (!fs.existsSync(outputPath)) {
        console.log(`Error: Directory ${outputPath} does not exist`);
        process.exit(1);
    }

    if (!fs.statSync(outputPath).isDirectory()) {
        console.log(`Error: ${outputPath} is not a directory`);
        process.exit(1);
    }

    showBanner();

    log(`Searching for package: ${packageName}`);
    log(`Requesting ${versionCount} version(s)`);
    log(`Output directory: ${outputPath}\n`);

    for (const registry of REGISTRIES) {
        log(`Checking ${registry}...`);

        const isTencent = registry.includes('tencent.com');
        const packageData = await getPackageInfo(registry, packageName, isTencent);
        
        if (!packageData) {
            continue;
        }

        const versions = getLastVersions(packageData, versionCount);

        if (versions.length === 0) {
            log("  No versions found");
            continue;
        }

        log(`  Found ${versions.length} version(s):`);
        versions.forEach(v => log(`    - ${v.version}`));

        if (isTencent) {
            log(`  Note: Tencent server may require multiple retry attempts\n`);
        }

        let successCount = 0;
        for (const versionInfo of versions) {
            const { version, url: tarballUrl } = versionInfo;

            if (tarballUrl.endsWith('0.0.1-security.tgz')) {
                log(`Skipping security placeholder version: ${version}`);
                continue;
            }

            const success = await downloadPackage(tarballUrl, packageName, version, outputPath, isTencent);
            if (success) {
                successCount++;
            }
        }

        if (successCount > 0) {
            log(`\nSuccessfully downloaded ${successCount} version(s) from ${registry}`);
            process.exit(0);
        } else {
            log(`\nFailed to download any versions from ${registry}\n`);
        }
    }

    log("Failed to download packages from any registry");
    process.exit(1);
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
