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

const NPM_VIEW_REGISTRIES = [
    "https://r.cnpmjs.org/",
    "https://registry.npmmirror.com/",
    "https://repo.huaweicloud.com/repository/npm/",
    "https://mirrors.cloud.tencent.com/npm/"
];

// Ecosyste.ms API endpoints for different registries
const ECOSYSTEMS_API = {
    npm: "https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/",
    pypi: "https://packages.ecosyste.ms/api/v1/registries/pypi.org/packages/"
};

const SUPPORTED_REGISTRIES = ['npm', 'pypi'];

const VERSION = "1.3.1";

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
 Package Recovery Tool v${VERSION}
 Supports: NPM, PyPI
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

Package Recovery Tool v${VERSION}
Created by 6mile - github.com/6mile

USAGE:
  undelete <registry> <package-name> [options]

REGISTRIES:
  npm                       NPM (npmjs.org) packages
  pypi                      PyPI (pypi.org) Python packages

OPTIONS:
  -n, --number <count>      Number of versions to download (1-20, default: 5)
  
  -p, --path <directory>    Save downloaded packages to specified directory
                            (default: current directory)
  
  -d, --data                Get package metadata instead of downloading files
  
  -s, --silent              Run in silent mode (JSON output for --data)
  
  -h, --help                Display this help message

  -v, --version             Show the version of undelete

EXAMPLES:
  undelete npm express
  undelete npm @angular/core -n 10
  undelete npm lodash --path ./downloads
  undelete npm react -p /tmp/packages -n 15 -s
  undelete npm express --data
  
  undelete pypi requests
  undelete pypi numpy --data
  undelete pypi flask -n 3 -p ./downloads

DESCRIPTION:
  Recovers packages that have been removed from NPM or PyPI registries.
  
  For NPM: Uses Chinese mirror servers that may still have cached copies.
  For PyPI: Uses ecosyste.ms which indexes files.pythonhosted.org URLs.
  
  The --data flag retrieves package metadata including maintainer info,
  which is useful for security research on removed malicious packages.
`);
    process.exit(0);
}

// ==========================================
// Ecosyste.ms API Functions
// ==========================================

/**
 * Fetch package data from ecosyste.ms API
 * @param {string} packageName - The package name to look up
 * @param {string} registry - The registry ('npm' or 'pypi')
 * @returns {Promise<Object|null>} - Package data or null if not found
 */
async function fetchEcosystemsPackageData(packageName, registry = 'npm') {
    return new Promise((resolve) => {
        // Handle scoped packages - ecosyste.ms uses URL encoding
        const encodedName = encodeURIComponent(packageName);
        const apiBase = ECOSYSTEMS_API[registry] || ECOSYSTEMS_API.npm;
        const url = `${apiBase}${encodedName}`;
        
        log(`  [ecosyste.ms] Fetching ${registry} package data...`);
        
        const request = https.get(url, { timeout: 15000 }, (response) => {
            if (response.statusCode === 200) {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        log(`  [ecosyste.ms] Error parsing JSON response`);
                        resolve(null);
                    }
                });
            } else if (response.statusCode === 404) {
                log(`  [ecosyste.ms] Package not found`);
                resolve(null);
            } else {
                log(`  [ecosyste.ms] HTTP ${response.statusCode}`);
                resolve(null);
            }
        });

        request.on('error', (e) => {
            log(`  [ecosyste.ms] Connection error: ${e.message}`);
            resolve(null);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [ecosyste.ms] Request timeout`);
            resolve(null);
        });
    });
}

/**
 * Get comprehensive data from ecosyste.ms
 * @param {string} packageName - The package name
 * @param {string} registry - The registry ('npm' or 'pypi')
 * @returns {Promise<Object>} - Package data including maintainers
 */
async function getEcosystemsData(packageName, registry = 'npm') {
    const packageData = await fetchEcosystemsPackageData(packageName, registry);
    
    if (!packageData) {
        return null;
    }
    
    // Maintainers are included in the main package response
    return {
        package: packageData,
        maintainers: packageData.maintainers || []
    };
}

/**
 * Fetch package versions from ecosyste.ms API
 * @param {string} packageName - The package name to look up
 * @param {string} registry - The registry ('npm' or 'pypi')
 * @returns {Promise<Array|null>} - Array of versions or null if not found
 */
async function fetchEcosystemsVersions(packageName, registry = 'npm') {
    return new Promise((resolve) => {
        const encodedName = encodeURIComponent(packageName);
        const apiBase = ECOSYSTEMS_API[registry] || ECOSYSTEMS_API.npm;
        const url = `${apiBase}${encodedName}/versions`;
        
        log(`  [ecosyste.ms] Fetching ${registry} versions...`);
        
        const request = https.get(url, { timeout: 15000 }, (response) => {
            if (response.statusCode === 200) {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } catch (e) {
                        log(`  [ecosyste.ms] Error parsing versions JSON`);
                        resolve(null);
                    }
                });
            } else if (response.statusCode === 404) {
                log(`  [ecosyste.ms] Package not found`);
                resolve(null);
            } else {
                log(`  [ecosyste.ms] HTTP ${response.statusCode}`);
                resolve(null);
            }
        });

        request.on('error', (e) => {
            log(`  [ecosyste.ms] Connection error: ${e.message}`);
            resolve(null);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [ecosyste.ms] Request timeout`);
            resolve(null);
        });
    });
}

/**
 * Extract useful metadata from ecosyste.ms response
 * @param {Object} ecosystemsData - Data from ecosyste.ms API
 * @returns {Object} - Normalized metadata
 */
function normalizeEcosystemsData(ecosystemsData) {
    const result = {
        downloads: null,
        downloadsLastMonth: null,
        maintainers: [],
        repository: null,
        homepage: null,
        license: null,
        description: null,
        latestVersion: null,
        firstPublished: null,
        lastPublished: null,
        dependentPackages: null,
        dependentRepos: null
    };
    
    if (ecosystemsData.package) {
        const pkg = ecosystemsData.package;
        
        result.downloads = pkg.downloads || null;
        result.downloadsLastMonth = pkg.downloads_period === 'last-month' ? pkg.downloads : null;
        result.repository = pkg.repository_url || null;
        result.homepage = pkg.homepage || null;
        result.license = pkg.normalized_licenses ? pkg.normalized_licenses.join(', ') : null;
        result.description = pkg.description || null;
        result.latestVersion = pkg.latest_release_number || null;
        result.firstPublished = pkg.first_release_published_at || null;
        result.lastPublished = pkg.latest_release_published_at || null;
        result.dependentPackages = pkg.dependent_packages_count || null;
        result.dependentRepos = pkg.dependent_repos_count || null;
    }
    
    if (ecosystemsData.maintainers && Array.isArray(ecosystemsData.maintainers)) {
        result.maintainers = ecosystemsData.maintainers.map(m => ({
            name: m.login || m.name || m.uuid || 'Unknown',
            email: m.email || null,
            uuid: m.uuid || null,
            packagesCount: m.packages_count || null,
            htmlUrl: m.html_url || null
        }));
    }
    
    return result;
}

// ==========================================
// Original Registry Functions
// ==========================================

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

function performDownload(url, packageName, version, outputPath, redirectCount = 0, customFilename = null) {
    const MAX_REDIRECTS = 5;
    
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) {
            reject(new Error('Too many redirects'));
            return;
        }
        
        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        
        // Use custom filename if provided, otherwise extract from URL or construct default
        let filename;
        if (customFilename) {
            filename = customFilename;
        } else {
            // Try to extract filename from URL path
            const urlFilename = path.basename(parsedUrl.pathname);
            if (urlFilename && (urlFilename.endsWith('.tgz') || urlFilename.endsWith('.tar.gz') || urlFilename.endsWith('.whl') || urlFilename.endsWith('.zip'))) {
                filename = urlFilename;
            } else {
                // Default to NPM-style naming
                filename = `${packageName.replace('/', '-')}-${version}.tgz`;
            }
        }
        
        const filepath = path.join(outputPath, filename);

        const request = protocol.get(url, { timeout: 30000 }, (response) => {
            // Handle redirects (301, 302, 303, 307, 308)
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const redirectUrl = response.headers.location;
                if (!redirectUrl) {
                    reject(new Error(`Redirect ${response.statusCode} without Location header`));
                    return;
                }
                
                // Resolve relative URLs against the original URL
                const absoluteUrl = new URL(redirectUrl, url).href;
                
                if (redirectCount === 0) {
                    log(`  Following redirect to ${absoluteUrl}`);
                }
                
                // Recursively follow the redirect, preserve the original filename
                performDownload(absoluteUrl, packageName, version, outputPath, redirectCount + 1, filename)
                    .then(resolve)
                    .catch(reject);
                return;
            }
            
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

/**
 * Check if metadata is missing critical fields
 * @param {Object} metadata - Package metadata from registry
 * @returns {Object} - Object indicating which fields are missing
 */
function checkMissingFields(metadata) {
    const missing = {
        author: false,
        email: false,
        maintainers: false
    };
    
    // Check if author info is missing
    if (!metadata.author || Object.keys(metadata.author).length === 0) {
        missing.author = true;
    }
    
    // Check if email is missing from npmUser and author
    const hasNpmUserEmail = metadata.npmUser && metadata.npmUser.email;
    const hasAuthorEmail = metadata.author && metadata.author.email;
    if (!hasNpmUserEmail && !hasAuthorEmail) {
        missing.email = true;
    }
    
    // Check if maintainers list is missing or empty
    if (!metadata.maintainers || metadata.maintainers.length === 0) {
        missing.maintainers = true;
    }
    
    return missing;
}

async function displayPackageData(packageName) {
    showBanner();
    
    log(`Fetching package metadata for: ${packageName}\n`);
    
    let foundRegistry = null;
    let metadata = null;
    let isSecurityPlaceholder = false;
    
    for (const registry of REGISTRIES) {
        log(`Checking ${registry}...`);
        
        const isTencent = registry.includes('tencent.com');
        const registryMetadata = await getPackageMetadata(registry, packageName, isTencent);
        
        if (!registryMetadata) {
            continue;
        }
        
        // Check if this is a security placeholder
        const versionIsSecurity = registryMetadata.version && registryMetadata.version.endsWith('0.0.1-security');
        const hasSecurityEmail = (email) => email && email === 'npm@npmjs.com';
        const npmUserHasSecurityEmail = registryMetadata.npmUser && hasSecurityEmail(registryMetadata.npmUser.email);
        const authorHasSecurityEmail = registryMetadata.author && hasSecurityEmail(registryMetadata.author.email);
        const allMaintainersHaveSecurityEmail = Array.isArray(registryMetadata.maintainers) && 
            registryMetadata.maintainers.length > 0 &&
            registryMetadata.maintainers.every(m => hasSecurityEmail(m.email));
        
        if (versionIsSecurity || npmUserHasSecurityEmail || authorHasSecurityEmail || allMaintainersHaveSecurityEmail) {
            log(`  Found security placeholder - will check ecosyste.ms for original data\n`);
            isSecurityPlaceholder = true;
            // Don't use this metadata as primary, but note that package exists
            continue;
        }
        
        metadata = registryMetadata;
        foundRegistry = registry;
        break;
    }
    
    // Always check ecosyste.ms for supplementary data, especially for security placeholders
    let ecosystemsData = null;
    let normalizedEcosystems = null;
    
    if (isSecurityPlaceholder || !metadata) {
        // Security placeholder or no data - ecosyste.ms is our primary source
        log(`Checking ecosyste.ms for package data...`);
        ecosystemsData = await getEcosystemsData(packageName);
        if (ecosystemsData) {
            normalizedEcosystems = normalizeEcosystemsData(ecosystemsData);
            if (normalizedEcosystems && (normalizedEcosystems.maintainers.length > 0 || normalizedEcosystems.description)) {
                log(`  [ecosyste.ms] Package data retrieved successfully`);
            }
        }
    } else if (metadata) {
        // We have registry data - check if any fields are missing
        const missing = checkMissingFields(metadata);
        if (missing.author || missing.email || missing.maintainers) {
            log(`\nSome metadata fields are missing, checking ecosyste.ms...`);
            ecosystemsData = await getEcosystemsData(packageName);
            if (ecosystemsData) {
                normalizedEcosystems = normalizeEcosystemsData(ecosystemsData);
                log(`  [ecosyste.ms] Additional data retrieved successfully`);
            }
        }
    }
    
    // If we still have no data at all
    if (!metadata && !normalizedEcosystems) {
        log("\nFailed to retrieve package metadata from any source");
        process.exit(1);
    }
    
    // Output the data
    if (SILENT_MODE) {
        // Build unified JSON output - prefer registry data unless security placeholder
        const useEcosystemsAsPrimary = isSecurityPlaceholder && normalizedEcosystems;
        
        // Determine best maintainers list
        let maintainers = [];
        if (!useEcosystemsAsPrimary && metadata && metadata.maintainers && metadata.maintainers.length > 0) {
            // Use registry maintainers, normalize format
            maintainers = metadata.maintainers.map(m => ({
                name: m.name || null,
                email: m.email || null
            }));
        } else if (normalizedEcosystems && normalizedEcosystems.maintainers && normalizedEcosystems.maintainers.length > 0) {
            // Use ecosyste.ms maintainers, normalize to same format
            maintainers = normalizedEcosystems.maintainers.map(m => ({
                name: m.name || null,
                email: m.email || null
            }));
        }
        
        // Determine npmUser and email - from registry or first ecosyste.ms maintainer
        let npmUser = null;
        let npmUserEmail = null;
        if (!useEcosystemsAsPrimary && metadata && metadata.npmUser) {
            npmUser = metadata.npmUser.name || null;
            npmUserEmail = metadata.npmUser.email || null;
        } else if (normalizedEcosystems && normalizedEcosystems.maintainers && normalizedEcosystems.maintainers.length > 0) {
            // Use first ecosyste.ms maintainer as npmUser
            const firstMaintainer = normalizedEcosystems.maintainers[0];
            npmUser = firstMaintainer.name || null;
            npmUserEmail = firstMaintainer.email || null;
        }
        
        const jsonOutput = {
            package: packageName,
            version: useEcosystemsAsPrimary 
                ? normalizedEcosystems.latestVersion 
                : (metadata ? metadata.version : (normalizedEcosystems ? normalizedEcosystems.latestVersion : null)),
            description: useEcosystemsAsPrimary
                ? normalizedEcosystems.description
                : (metadata && metadata.description ? metadata.description : (normalizedEcosystems ? normalizedEcosystems.description : null)),
            npmUser: npmUser,
            npmUserEmail: npmUserEmail,
            maintainers: maintainers,
            // Additional fields from either source
            repository: normalizedEcosystems ? normalizedEcosystems.repository : null,
            license: normalizedEcosystems ? normalizedEcosystems.license : null,
            downloads: normalizedEcosystems ? normalizedEcosystems.downloads : null,
            dependentPackages: normalizedEcosystems ? normalizedEcosystems.dependentPackages : null,
            dependentRepos: normalizedEcosystems ? normalizedEcosystems.dependentRepos : null,
            firstPublished: normalizedEcosystems ? normalizedEcosystems.firstPublished : null,
            lastPublished: normalizedEcosystems ? normalizedEcosystems.lastPublished : null,
            isSecurityPlaceholder: isSecurityPlaceholder
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        process.exit(0);
    }
    
    // Human-readable output
    if (isSecurityPlaceholder) {
        log(`\n⚠️  This package has been replaced with a security placeholder on NPM`);
        log(`   Original package data recovered from ecosyste.ms:\n`);
    }
    
    log(`Package: ${packageName}`);
    
    // Prefer ecosyste.ms data for security placeholders
    if (isSecurityPlaceholder && normalizedEcosystems) {
        log(`Version: ${normalizedEcosystems.latestVersion || 'Unknown'}`);
        if (normalizedEcosystems.description) {
            log(`Description: ${normalizedEcosystems.description}`);
        }
    } else {
        log(`Version: ${metadata ? metadata.version : (normalizedEcosystems ? normalizedEcosystems.latestVersion : 'Unknown')}`);
        const description = metadata && metadata.description ? metadata.description : 
                           (normalizedEcosystems ? normalizedEcosystems.description : null);
        if (description) {
            log(`Description: ${description}`);
        }
    }
    log('');
    
    // For non-security-placeholder packages, show registry data first
    if (!isSecurityPlaceholder && metadata) {
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
            log(`Maintainers (from registry):`);
            metadata.maintainers.forEach((maintainer, index) => {
                log(`  ${index + 1}. ${maintainer.name || 'N/A'}`);
                if (maintainer.email) log(`     Email: ${maintainer.email}`);
            });
            log('');
        }
    }
    
    // Display ecosyste.ms data
    if (normalizedEcosystems) {
        if (!isSecurityPlaceholder) {
            log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            log(`Data from ecosyste.ms:`);
            log('');
        }
        
        if (normalizedEcosystems.downloads !== null) {
            const formattedDownloads = normalizedEcosystems.downloads.toLocaleString();
            log(`  Downloads (last month): ${formattedDownloads}`);
        }
        
        if (normalizedEcosystems.license) {
            log(`  License: ${normalizedEcosystems.license}`);
        }
        
        if (normalizedEcosystems.repository) {
            log(`  Repository: ${normalizedEcosystems.repository}`);
        }
        
        if (normalizedEcosystems.dependentPackages !== null) {
            log(`  Dependent packages: ${normalizedEcosystems.dependentPackages.toLocaleString()}`);
        }
        
        if (normalizedEcosystems.dependentRepos !== null) {
            log(`  Dependent repos: ${normalizedEcosystems.dependentRepos.toLocaleString()}`);
        }
        
        if (normalizedEcosystems.firstPublished) {
            log(`  First published: ${normalizedEcosystems.firstPublished}`);
        }
        
        if (normalizedEcosystems.lastPublished) {
            log(`  Last published: ${normalizedEcosystems.lastPublished}`);
        }
        
        if (normalizedEcosystems.maintainers && normalizedEcosystems.maintainers.length > 0) {
            log('');
            log(`  Maintainers (from ecosyste.ms):`);
            normalizedEcosystems.maintainers.forEach((maintainer, index) => {
                log(`    ${index + 1}. ${maintainer.name}`);
                if (maintainer.email) log(`       Email: ${maintainer.email}`);
                if (maintainer.packagesCount) log(`       Packages: ${maintainer.packagesCount}`);
                if (maintainer.htmlUrl) log(`       Profile: ${maintainer.htmlUrl}`);
            });
        }
        log('');
    }
    
    if (foundRegistry) {
        log(`Primary data from: ${foundRegistry}`);
    }
    if (ecosystemsData) {
        log(`${isSecurityPlaceholder ? 'Original package' : 'Supplementary'} data from: ecosyste.ms`);
    }
    
    process.exit(0);
}

// ==========================================
// PyPI-specific Functions
// ==========================================

/**
 * Display PyPI package data (--data mode)
 * @param {string} packageName - The package name
 */
async function displayPyPIPackageData(packageName) {
    showBanner();
    
    log(`Fetching PyPI package metadata for: ${packageName}\n`);
    log(`Checking ecosyste.ms...`);
    
    const ecosystemsData = await getEcosystemsData(packageName, 'pypi');
    
    if (!ecosystemsData) {
        log("\nFailed to retrieve package metadata from ecosyste.ms");
        process.exit(1);
    }
    
    const normalizedEcosystems = normalizeEcosystemsData(ecosystemsData);
    
    if (!normalizedEcosystems) {
        log("\nFailed to parse package metadata");
        process.exit(1);
    }
    
    log(`  [ecosyste.ms] Package data retrieved successfully`);
    
    // Output the data
    if (SILENT_MODE) {
        // Determine maintainer info
        let maintainers = [];
        let primaryUser = null;
        let primaryEmail = null;
        
        if (normalizedEcosystems.maintainers && normalizedEcosystems.maintainers.length > 0) {
            maintainers = normalizedEcosystems.maintainers.map(m => ({
                name: m.name || null,
                email: m.email || null
            }));
            primaryUser = normalizedEcosystems.maintainers[0].name || null;
            primaryEmail = normalizedEcosystems.maintainers[0].email || null;
        }
        
        const jsonOutput = {
            package: packageName,
            version: normalizedEcosystems.latestVersion,
            description: normalizedEcosystems.description,
            maintainer: primaryUser,
            maintainerEmail: primaryEmail,
            maintainers: maintainers,
            repository: normalizedEcosystems.repository,
            license: normalizedEcosystems.license,
            downloads: normalizedEcosystems.downloads,
            dependentPackages: normalizedEcosystems.dependentPackages,
            dependentRepos: normalizedEcosystems.dependentRepos,
            firstPublished: normalizedEcosystems.firstPublished,
            lastPublished: normalizedEcosystems.lastPublished,
            registry: 'pypi'
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        process.exit(0);
    }
    
    // Human-readable output
    log(`\nPackage: ${packageName}`);
    log(`Version: ${normalizedEcosystems.latestVersion || 'Unknown'}`);
    if (normalizedEcosystems.description) {
        log(`Description: ${normalizedEcosystems.description}`);
    }
    log('');
    
    if (normalizedEcosystems.downloads !== null) {
        log(`Downloads (last month): ${normalizedEcosystems.downloads.toLocaleString()}`);
    }
    
    if (normalizedEcosystems.license) {
        log(`License: ${normalizedEcosystems.license}`);
    }
    
    if (normalizedEcosystems.repository) {
        log(`Repository: ${normalizedEcosystems.repository}`);
    }
    
    if (normalizedEcosystems.dependentPackages !== null) {
        log(`Dependent packages: ${normalizedEcosystems.dependentPackages.toLocaleString()}`);
    }
    
    if (normalizedEcosystems.dependentRepos !== null) {
        log(`Dependent repos: ${normalizedEcosystems.dependentRepos.toLocaleString()}`);
    }
    
    if (normalizedEcosystems.firstPublished) {
        log(`First published: ${normalizedEcosystems.firstPublished}`);
    }
    
    if (normalizedEcosystems.lastPublished) {
        log(`Last published: ${normalizedEcosystems.lastPublished}`);
    }
    
    if (normalizedEcosystems.maintainers && normalizedEcosystems.maintainers.length > 0) {
        log('');
        log(`Maintainers:`);
        normalizedEcosystems.maintainers.forEach((maintainer, index) => {
            log(`  ${index + 1}. ${maintainer.name}`);
            if (maintainer.email) log(`     Email: ${maintainer.email}`);
            if (maintainer.packagesCount) log(`     Packages: ${maintainer.packagesCount}`);
            if (maintainer.htmlUrl) log(`     Profile: ${maintainer.htmlUrl}`);
        });
    }
    
    log('');
    log(`Data from: ecosyste.ms (pypi.org)`);
    
    process.exit(0);
}

/**
 * Download PyPI packages using ecosyste.ms version data
 * @param {string} packageName - The package name
 * @param {number} versionCount - Number of versions to download
 * @param {string} outputPath - Directory to save files
 */
async function downloadPyPIPackages(packageName, versionCount, outputPath) {
    showBanner();
    
    log(`Searching for PyPI package: ${packageName}`);
    log(`Requesting ${versionCount} version(s)`);
    log(`Output directory: ${outputPath}\n`);
    
    log(`Checking ecosyste.ms for package versions...`);
    
    // Fetch versions from ecosyste.ms
    const versions = await fetchEcosystemsVersions(packageName, 'pypi');
    
    if (!versions || versions.length === 0) {
        log(`\nNo versions found for ${packageName} on ecosyste.ms`);
        process.exit(1);
    }
    
    // Sort by published_at descending (newest first) and take requested count
    versions.sort((a, b) => {
        const dateA = new Date(a.published_at || 0);
        const dateB = new Date(b.published_at || 0);
        return dateB - dateA;
    });
    
    const selectedVersions = versions.slice(0, versionCount);
    
    log(`  Found ${versions.length} total version(s), downloading ${selectedVersions.length}:`);
    selectedVersions.forEach(v => log(`    - ${v.number}`));
    log('');
    
    let successCount = 0;
    for (const versionData of selectedVersions) {
        const version = versionData.number;
        const downloadUrl = versionData.download_url;
        
        if (!downloadUrl) {
            log(`  No download URL for version ${version}, skipping...`);
            continue;
        }
        
        log(`Downloading ${packageName}@${version}...`);
        
        try {
            const success = await performDownload(downloadUrl, packageName, version, outputPath);
            if (success) {
                successCount++;
            }
        } catch (e) {
            log(`  Download failed: ${e.message}`);
        }
    }
    
    if (successCount > 0) {
        log(`\nSuccessfully downloaded ${successCount} version(s) from files.pythonhosted.org`);
        process.exit(0);
    } else {
        log(`\nFailed to download any versions`);
        process.exit(1);
    }
}

// ==========================================
// NPM CLI Fallback Method
// ==========================================

async function tryNpmViewMethod(packageName, versionCount, outputPath) {
    log(`\nTrying npm view CLI method with Chinese mirrors...`);
    
    for (const registry of NPM_VIEW_REGISTRIES) {
        log(`\nChecking ${registry} via npm view...`);
        
        try {
            const command = `npm view ${packageName} --json --registry ${registry}`;
            const { stdout, stderr } = await execPromise(command, { 
                timeout: 15000,
                maxBuffer: 10 * 1024 * 1024 
            });
            
            if (stderr && !stderr.includes('npm notice')) {
                log(`  Warning: ${stderr.trim()}`);
            }
            
            const data = JSON.parse(stdout);
            
            // Handle both single version and multiple versions
            const versions = Array.isArray(data) ? data : [data];
            
            // Sort versions and take the requested count
            versions.sort((a, b) => compareVersions(a.version, b.version));
            const selectedVersions = versions.slice(0, versionCount);
            
            const validTarballs = [];
            for (const versionData of selectedVersions) {
                if (versionData.dist && versionData.dist.tarball) {
                    const tarball = versionData.dist.tarball;
                    
                    // Skip security placeholder tarballs
                    if (!tarball.endsWith('0.0.1-security.tgz')) {
                        validTarballs.push({
                            version: versionData.version,
                            url: tarball
                        });
                    }
                }
            }
            
            if (validTarballs.length === 0) {
                log(`  No valid tarballs found (only security placeholders)`);
                continue;
            }
            
            log(`  Found ${validTarballs.length} valid tarball(s):`);
            validTarballs.forEach(v => log(`    - ${v.version}`));
            
            let successCount = 0;
            for (const tarballInfo of validTarballs) {
                const { version, url: tarballUrl } = tarballInfo;
                const success = await downloadPackage(tarballUrl, packageName, version, outputPath, false);
                if (success) {
                    successCount++;
                }
            }
            
            if (successCount > 0) {
                log(`\nSuccessfully downloaded ${successCount} version(s) using npm view method from ${registry}`);
                return true;
            } else {
                log(`\nFailed to download any versions from ${registry}`);
            }
            
        } catch (error) {
            if (error.code === 'E404' || error.message.includes('404')) {
                log(`  Package not found in ${registry}`);
            } else if (error.killed || error.signal === 'SIGTERM') {
                log(`  Timeout connecting to ${registry}`);
            } else {
                log(`  Error: ${error.message}`);
            }
            continue;
        }
    }
    
    return false;
}

async function main() {
    const args = process.argv.slice(2);
    let registry = null;
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
        } else if (!registry) {
            // First positional argument is registry
            registry = args[i].toLowerCase();
        } else if (!packageName) {
            // Second positional argument is package name
            packageName = args[i];
        }
    }

    // Validate registry
    if (!registry) {
        console.log("Usage: undelete <registry> <package-name> [options]");
        console.log("Registries: npm, pypi");
        console.log("Try 'undelete --help' for more information.");
        process.exit(1);
    }
    
    if (!SUPPORTED_REGISTRIES.includes(registry)) {
        console.log(`Error: Unsupported registry '${registry}'`);
        console.log(`Supported registries: ${SUPPORTED_REGISTRIES.join(', ')}`);
        process.exit(1);
    }

    if (!packageName) {
        console.log("Usage: undelete <registry> <package-name> [options]");
        console.log("Try 'undelete --help' for more information.");
        process.exit(1);
    }

    // Route to appropriate handler based on registry
    if (registry === 'pypi') {
        if (dataMode) {
            await displayPyPIPackageData(packageName);
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
        
        await downloadPyPIPackages(packageName, versionCount, outputPath);
        return;
    }
    
    // NPM registry handling (default)
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

    // Try the npm view CLI method as a fallback
    const npmViewSuccess = await tryNpmViewMethod(packageName, versionCount, outputPath);
    if (npmViewSuccess) {
        process.exit(0);
    }

    log("\nFailed to download packages from any registry or method");
    process.exit(1);
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
