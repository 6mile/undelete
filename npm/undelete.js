#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');

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

// kmsec.uk DPRK research archive for removed npm packages
const KMSEC_API = "https://dprk-research.kmsec.uk/api/tarfiles/";
const KMSEC_LISTING = "https://dprk-research.kmsec.uk/?json";

// socket.dev: package pages are Cloudflare-protected, but raw file bodies are
// served content-addressed and unauthenticated from socketusercontent.com/blob/<hash>.
const SOCKET_BASE = "https://socket.dev";
const SOCKET_BLOB_BASE = "https://socketusercontent.com/blob/";

// Ecosyste.ms API endpoints for different registries
const ECOSYSTEMS_API = {
    npm: "https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/",
    pypi: "https://packages.ecosyste.ms/api/v1/registries/pypi.org/packages/",
    rubygems: "https://packages.ecosyste.ms/api/v1/registries/rubygems.org/packages/"
};

// BigQuery fallback for deleted PyPI packages (uses OAuth2 with service account)

// Full-mirror rubygems.org clones. TUNA runs a proper file mirror (not a CDN),
// so yanked gems often survive there until the next sync. Ordered best-first.
const GEM_MIRRORS = [
    'https://mirrors.tuna.tsinghua.edu.cn/rubygems/gems/{name}-{version}.gem',
    'https://mirrors.ustc.edu.cn/rubygems/gems/{name}-{version}.gem',
    'https://mirrors.bfsu.edu.cn/rubygems/gems/{name}-{version}.gem',
    'https://mirrors.aliyun.com/rubygems/gems/{name}-{version}.gem',
    'https://repo.huaweicloud.com/repository/rubygems/gems/{name}-{version}.gem',
    'https://gems.ruby-china.com/gems/{name}-{version}.gem'
];

const SUPPORTED_REGISTRIES = ['npm', 'pypi', 'rubygems', 'gem'];

const VERSION = "2.1.0";

/**
 * Check if a tarball URL is a security placeholder
 * Matches patterns like:
 * - package-0.0.1-security.tgz
 * - package-0.0.1-security.0.tgz
 * @param {string} tarballUrl - The tarball URL to check
 * @returns {boolean} - True if it's a security placeholder
 */
function isSecurityPlaceholderTarball(tarballUrl) {
    return /0\.0\.1-security(\.\d+)?\.tgz$/.test(tarballUrl);
}

function isSecurityPlaceholderVersion(version) {
    return /^0\.0\.1-security(\.\d+)?$/.test(version);
}

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
 Supports: NPM, PyPI, RubyGems
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
  rubygems (or gem)         RubyGems (rubygems.org) Ruby packages

OPTIONS:
  -n, --number <count>      Number of versions to download (1-20, default: 5)

  -t, --target-version <v>  Look up exactly this version (overrides -n).
                            Errors and lists available versions if not found.

  -p, --path <directory>    Save downloaded packages to specified directory
                            (default: current directory)

  -d, --data                Get package metadata instead of downloading files

  -s, --silent              Run in silent mode (JSON output for --data)

  --gcp-credentials <file>  Path to GCP service account JSON file for PyPI
                            BigQuery fallback (also reads GCP_CREDENTIALS env var)

  --socket                  Pull files from socket.dev (npm and rubygems).
                            Skips all other sources. Requires puppeteer + Chrome;
                            slower because Socket serves individual files, which
                            are repackaged locally into <pkg>-<version>.tgz for
                            npm or <pkg>-<version>-source.tar.gz for rubygems
                            (not a valid .gem — the source files only).

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
  undelete pypi elementary-data --target-version 0.23.3
  undelete npm chalk -t 5.3.0 --data
  undelete npm hexdrift --socket -n 1 -p ./downloads
  undelete npm some-removed-pkg --socket -t 1.2.3

  undelete rubygems rails
  undelete gem sinatra -n 3 -p ./gems
  undelete rubygems some-yanked-gem --socket

DESCRIPTION:
  Recovers packages that have been removed from NPM, PyPI, or RubyGems.

  For NPM: Uses Chinese mirror servers that may still have cached copies.
           Falls back to kmsec.uk DPRK research archive for malicious packages.
           With --socket, pulls files from socket.dev (exclusive, no fallback
           chain) and repackages them into a .tgz.
  For RubyGems: Discovers versions via ecosyste.ms, then tries rubygems.org
           directly (works for non-yanked gems), then Chinese full mirrors
           (TUNA, USTC, BFSU, Aliyun, Huawei, Ruby China) which often retain
           yanked gems until their next sync. With --socket, pulls source
           files from socket.dev and packages them as a plain source tarball.
  For PyPI: Uses ecosyste.ms which indexes files.pythonhosted.org URLs.
           If ecosyste.ms has no data, falls back to:
           1. PyPI JSON API (for non-quarantined packages)
           2. PyPI Simple API (detects quarantine status)
           3. Puppeteer headless browser (for quarantined package details)
           4. BigQuery (requires GCP credentials) for deleted packages

  Quarantined packages: When PyPI flags a package as malicious, it is
  quarantined and hidden from the JSON API. This tool uses a headless
  browser (Puppeteer) to scrape the project page for maintainer info.

  The --data flag retrieves package metadata including maintainer info,
  which is useful for security research on removed malicious packages.

OPTIONAL DEPENDENCIES:
  For quarantined PyPI packages, install puppeteer for full metadata:
    npm install puppeteer        # includes bundled Chromium
    npm install puppeteer-core   # uses system Chrome (lighter)

BIGQUERY SETUP (for PyPI fallback):
  1. Create a Google Cloud project (free tier available)
  2. Enable the BigQuery API
  3. Create a service account and download the JSON key file
  4. Pass via --gcp-credentials or GCP_CREDENTIALS environment variable
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
 * Generate a signed JWT for Google service account authentication
 * @param {Object} credentials - Service account credentials from JSON file
 * @returns {string} - Signed JWT token
 */
function generateServiceAccountJWT(credentials) {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600; // 1 hour

    const header = {
        alg: 'RS256',
        typ: 'JWT'
    };

    const payload = {
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/bigquery.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: expiry
    };

    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${base64Header}.${base64Payload}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(credentials.private_key, 'base64url');

    return `${signatureInput}.${signature}`;
}

/**
 * Exchange a signed JWT for a Google OAuth2 access token
 * @param {string} jwt - Signed JWT token
 * @returns {Promise<string|null>} - Access token or null on failure
 */
async function getGoogleAccessToken(jwt) {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt
        }).toString();

        const options = {
            hostname: 'oauth2.googleapis.com',
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 15000
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.access_token) {
                        resolve(parsed.access_token);
                    } else {
                        log(`  [BigQuery] OAuth error: ${parsed.error_description || parsed.error || 'Unknown'}`);
                        resolve(null);
                    }
                } catch (e) {
                    log(`  [BigQuery] Error parsing OAuth response: ${e.message}`);
                    resolve(null);
                }
            });
        });

        request.on('error', (e) => {
            log(`  [BigQuery] OAuth connection error: ${e.message}`);
            resolve(null);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [BigQuery] OAuth request timeout`);
            resolve(null);
        });

        request.write(postData);
        request.end();
    });
}

/**
 * Load and validate GCP service account credentials from a JSON file
 * @param {string} credentialsPath - Path to the service account JSON file
 * @returns {Object|null} - Credentials object or null if invalid
 */
function loadGCPCredentials(credentialsPath) {
    try {
        const content = fs.readFileSync(credentialsPath, 'utf8');
        const credentials = JSON.parse(content);

        if (!credentials.client_email || !credentials.private_key || !credentials.project_id) {
            log(`  [BigQuery] Invalid credentials file: missing required fields`);
            return null;
        }

        return credentials;
    } catch (e) {
        log(`  [BigQuery] Error loading credentials: ${e.message}`);
        return null;
    }
}

/**
 * Fetch PyPI package download URLs from BigQuery public dataset
 * This is a fallback when ecosyste.ms doesn't have download URLs
 * @param {string} packageName - The package name to look up
 * @param {string} credentialsPath - Path to GCP service account JSON file
 * @returns {Promise<Array>} - Array of { version, url, filename } or empty array
 */
async function fetchPyPIUrlsFromBigQuery(packageName, credentialsPath) {
    // Load and validate credentials
    const credentials = loadGCPCredentials(credentialsPath);
    if (!credentials) {
        return [];
    }

    // Generate JWT and exchange for access token
    log(`  [BigQuery] Authenticating with service account...`);
    const jwt = generateServiceAccountJWT(credentials);
    const accessToken = await getGoogleAccessToken(jwt);

    if (!accessToken) {
        return [];
    }

    return new Promise((resolve) => {
        const query = `
            SELECT name, version, path, filename
            FROM \`bigquery-public-data.pypi.distribution_metadata\`
            WHERE LOWER(name) = LOWER(@pkg)
        `;

        const requestBody = JSON.stringify({
            query: query,
            useLegacySql: false,
            parameterMode: "NAMED",
            queryParameters: [{
                name: "pkg",
                parameterType: { type: "STRING" },
                parameterValue: { value: packageName }
            }]
        });

        const options = {
            hostname: 'bigquery.googleapis.com',
            path: `/bigquery/v2/projects/${credentials.project_id}/queries`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Authorization': `Bearer ${accessToken}`
            },
            timeout: 30000
        };

        log(`  [BigQuery] Querying PyPI distribution metadata...`);

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(data);

                    if (parsed.error) {
                        log(`  [BigQuery] API error: ${parsed.error.message || 'Unknown error'}`);
                        resolve([]);
                        return;
                    }

                    if (!parsed.rows || parsed.rows.length === 0) {
                        log(`  [BigQuery] No results found`);
                        resolve([]);
                        return;
                    }

                    // Parse the results
                    // Schema: name (f[0]), version (f[1]), path (f[2]), filename (f[3])
                    const results = parsed.rows.map(row => {
                        const version = row.f[1].v;
                        const pathValue = row.f[2].v;
                        const filename = row.f[3].v;

                        // Construct the full URL from the path
                        // path format: xx/yy/hash/filename
                        const url = `https://files.pythonhosted.org/packages/${pathValue}`;

                        return { version, url, filename };
                    });

                    log(`  [BigQuery] Found ${results.length} file(s)`);
                    resolve(results);
                } catch (e) {
                    log(`  [BigQuery] Error parsing response: ${e.message}`);
                    resolve([]);
                }
            });
        });

        request.on('error', (e) => {
            log(`  [BigQuery] Connection error: ${e.message}`);
            resolve([]);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [BigQuery] Request timeout`);
            resolve([]);
        });

        request.write(requestBody);
        request.end();
    });
}

/**
 * Fetch package data from PyPI JSON API
 * This is the preferred method for getting full package metadata
 * @param {string} packageName - The package name to look up
 * @returns {Promise<Object|null>} - Package data or null if not found
 */
async function fetchPyPIJsonApi(packageName) {
    return new Promise((resolve) => {
        const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;

        log(`  [pypi.org] Fetching JSON API...`);

        const request = https.get(url, { timeout: 15000 }, (response) => {
            if (response.statusCode === 200) {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const info = parsed.info || {};

                        // Extract download URLs from releases
                        const downloadUrls = [];
                        if (parsed.urls && Array.isArray(parsed.urls)) {
                            for (const file of parsed.urls) {
                                if (file.url) {
                                    downloadUrls.push({
                                        url: file.url,
                                        filename: file.filename || file.url.split('/').pop(),
                                        packagetype: file.packagetype
                                    });
                                }
                            }
                        }

                        const result = {
                            name: packageName,
                            version: info.version || null,
                            description: info.summary || info.description || null,
                            maintainer: info.maintainer || info.author || null,
                            maintainerEmail: info.maintainer_email || info.author_email || null,
                            homepage: info.home_page || info.project_url || null,
                            license: info.license || null,
                            downloadUrls: downloadUrls,
                            isQuarantined: false,
                            source: 'pypi.org'
                        };

                        log(`  [pypi.org] Found: version=${result.version || 'unknown'}, author=${result.maintainer || 'unknown'}`);
                        resolve(result);
                    } catch (e) {
                        log(`  [pypi.org] Error parsing JSON: ${e.message}`);
                        resolve(null);
                    }
                });
            } else if (response.statusCode === 404) {
                log(`  [pypi.org] JSON API returned 404 (package may be quarantined)`);
                resolve(null);
            } else {
                log(`  [pypi.org] JSON API HTTP ${response.statusCode}`);
                resolve(null);
            }
        });

        request.on('error', (e) => {
            log(`  [pypi.org] Connection error: ${e.message}`);
            resolve(null);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [pypi.org] Request timeout`);
            resolve(null);
        });
    });
}

/**
 * Fetch package data from PyPI Simple API
 * This works even for quarantined packages and can detect quarantine status
 * @param {string} packageName - The package name to look up
 * @returns {Promise<Object|null>} - Package data or null if not found
 */
async function fetchPyPISimpleApi(packageName) {
    return new Promise((resolve) => {
        const url = `https://pypi.org/simple/${encodeURIComponent(packageName)}/`;

        log(`  [pypi.org] Fetching Simple API...`);

        const request = https.get(url, { timeout: 15000 }, (response) => {
            if (response.statusCode === 200) {
                let html = '';
                response.on('data', chunk => html += chunk);
                response.on('end', () => {
                    const result = {
                        name: packageName,
                        version: null,
                        description: null,
                        maintainer: null,
                        maintainerEmail: null,
                        downloadUrls: [],
                        isQuarantined: false,
                        source: 'pypi.org'
                    };

                    // Check for quarantine status
                    if (html.includes('content="quarantined"') ||
                        html.includes("content='quarantined'") ||
                        html.includes('pypi:project-status" content="quarantined"')) {
                        result.isQuarantined = true;
                        log(`  [pypi.org] Package is quarantined`);
                    }

                    // Extract download URLs from Simple API
                    // Format: <a href="https://files.pythonhosted.org/packages/...">filename</a>
                    const linkPattern = /<a[^>]+href="(https:\/\/files\.pythonhosted\.org\/packages\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
                    let match;
                    const seenUrls = new Set();

                    while ((match = linkPattern.exec(html)) !== null) {
                        const url = match[1];
                        const filename = match[2].trim();

                        if (!seenUrls.has(url)) {
                            seenUrls.add(url);

                            // Extract version from filename
                            let version = null;
                            const versionMatch = filename.match(/-(\d+\.\d+(?:\.\d+)?(?:[\w.-]*)?)(?:\.tar\.gz|\.whl|\.zip|-py|-cp)/);
                            if (versionMatch) {
                                version = versionMatch[1];
                                // Update result version to latest found
                                if (!result.version || compareVersions(version, result.version) < 0) {
                                    result.version = version;
                                }
                            }

                            result.downloadUrls.push({
                                url: url,
                                filename: filename,
                                version: version
                            });
                        }
                    }

                    if (result.isQuarantined || result.downloadUrls.length > 0) {
                        log(`  [pypi.org] Found: quarantined=${result.isQuarantined}, files=${result.downloadUrls.length}`);
                        resolve(result);
                    } else {
                        log(`  [pypi.org] No data found in Simple API`);
                        resolve(null);
                    }
                });
            } else if (response.statusCode === 404) {
                log(`  [pypi.org] Package not found`);
                resolve(null);
            } else {
                log(`  [pypi.org] Simple API HTTP ${response.statusCode}`);
                resolve(null);
            }
        });

        request.on('error', (e) => {
            log(`  [pypi.org] Connection error: ${e.message}`);
            resolve(null);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [pypi.org] Request timeout`);
            resolve(null);
        });
    });
}

/**
 * Try to load puppeteer or puppeteer-core dynamically
 * @returns {Object|null} - Puppeteer module or null if not available
 */
function tryLoadPuppeteer() {
    try {
        return require('puppeteer');
    } catch (e) {
        try {
            return require('puppeteer-core');
        } catch (e2) {
            return null;
        }
    }
}

/**
 * Find Chrome/Chromium executable path for puppeteer-core
 * @returns {string|null} - Path to Chrome executable or null
 */
function findChromePath() {
    const { execSync } = require('child_process');
    const platform = process.platform;

    const paths = [];

    if (platform === 'darwin') {
        paths.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        );
    } else if (platform === 'linux') {
        paths.push(
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        );
        // Try which command
        try {
            const chromePath = execSync('which google-chrome || which chromium || which chromium-browser', { encoding: 'utf8' }).trim();
            if (chromePath) paths.unshift(chromePath);
        } catch (e) {}
    } else if (platform === 'win32') {
        paths.push(
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
        );
    }

    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                return p;
            }
        } catch (e) {}
    }

    return null;
}

/**
 * Scrape PyPI project page using Puppeteer (headless browser)
 * This bypasses JavaScript challenges and can access quarantined package pages
 * @param {string} packageName - The package name to look up
 * @returns {Promise<Object|null>} - Scraped package data or null
 */
async function scrapePyPIWithPuppeteer(packageName) {
    const puppeteer = tryLoadPuppeteer();

    if (!puppeteer) {
        log(`  [puppeteer] Not installed. Install with: npm install puppeteer`);
        return null;
    }

    let browser = null;
    try {
        log(`  [puppeteer] Launching headless browser...`);

        // Determine launch options
        const launchOptions = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };

        // If using puppeteer-core, we need to specify executablePath
        if (puppeteer.executablePath && typeof puppeteer.executablePath === 'function') {
            // Full puppeteer - has bundled browser
            try {
                launchOptions.executablePath = puppeteer.executablePath();
            } catch (e) {
                // May not have bundled browser, try to find system Chrome
                const chromePath = findChromePath();
                if (chromePath) {
                    launchOptions.executablePath = chromePath;
                }
            }
        } else {
            // puppeteer-core - needs system Chrome
            const chromePath = findChromePath();
            if (!chromePath) {
                log(`  [puppeteer] No Chrome/Chromium found. Install Chrome or use 'npm install puppeteer'`);
                return null;
            }
            launchOptions.executablePath = chromePath;
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();

        // Set a realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const url = `https://pypi.org/project/${encodeURIComponent(packageName)}/`;
        log(`  [puppeteer] Navigating to ${url}...`);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait a moment for any dynamic content
        await page.waitForSelector('h1', { timeout: 10000 }).catch(() => {});

        // Extract data from the page
        const data = await page.evaluate(() => {
            const result = {
                version: null,
                description: null,
                maintainer: null,
                maintainerUrl: null,
                isQuarantined: false
            };

            // Check for quarantine banner
            const bodyText = document.body.innerText || '';
            if (bodyText.includes('quarantined') || bodyText.includes('under review')) {
                result.isQuarantined = true;
            }

            // Get version from h1 (format: "packagename X.Y.Z")
            const h1 = document.querySelector('h1.package-header__name');
            if (h1) {
                const text = h1.textContent.trim();
                const match = text.match(/\s+(\d+\.\d+(?:\.\d+)?(?:[\w.-]*)?)$/);
                if (match) {
                    result.version = match[1];
                }
            }

            // Get description from meta tag
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc) {
                result.description = metaDesc.getAttribute('content');
            }

            // Get maintainer from sidebar
            const maintainerLink = document.querySelector('.sidebar-section__maintainer a[href^="/user/"]');
            if (maintainerLink) {
                result.maintainer = maintainerLink.textContent.trim();
                result.maintainerUrl = 'https://pypi.org' + maintainerLink.getAttribute('href');
            }

            // Fallback: try author from metadata
            if (!result.maintainer) {
                const authorEl = document.querySelector('.author, [data-controller="author"]');
                if (authorEl) {
                    const link = authorEl.querySelector('a');
                    result.maintainer = link ? link.textContent.trim() : authorEl.textContent.trim();
                }
            }

            // Another fallback: look for Author: label
            if (!result.maintainer) {
                const sidebar = document.querySelector('.sidebar-section');
                if (sidebar) {
                    const text = sidebar.innerHTML;
                    const authorMatch = text.match(/Author[:\s]*<[^>]*>([^<]+)</i);
                    if (authorMatch) {
                        result.maintainer = authorMatch[1].trim();
                    }
                }
            }

            return result;
        });

        await browser.close();
        browser = null;

        if (data.version || data.maintainer) {
            log(`  [puppeteer] Found: version=${data.version || 'unknown'}, maintainer=${data.maintainer || 'unknown'}`);
            return {
                name: packageName,
                version: data.version,
                description: data.description,
                maintainer: data.maintainer,
                maintainerUrl: data.maintainerUrl,
                maintainerEmail: null,
                downloadUrls: [],
                isQuarantined: data.isQuarantined,
                source: 'pypi.org (puppeteer)'
            };
        }

        log(`  [puppeteer] Could not extract data from page`);
        return null;

    } catch (e) {
        log(`  [puppeteer] Error: ${e.message}`);
        if (browser) {
            try { await browser.close(); } catch (e2) {}
        }
        return null;
    }
}

/**
 * Get PyPI package data using JSON API with Simple API and Puppeteer fallbacks
 * JSON API provides full metadata but returns 404 for quarantined packages
 * Simple API works for quarantined packages but only provides download links
 * Puppeteer can scrape the full page including maintainer info for quarantined packages
 * @param {string} packageName - The package name to look up
 * @returns {Promise<Object|null>} - Package data or null if not found
 */
async function scrapePyPIProjectPage(packageName) {
    // First try JSON API (gives full metadata)
    const jsonData = await fetchPyPIJsonApi(packageName);
    if (jsonData) {
        return jsonData;
    }

    // Fall back to Simple API (works for quarantined packages)
    const simpleData = await fetchPyPISimpleApi(packageName);

    // If quarantined and missing author info, try Puppeteer
    if (simpleData && simpleData.isQuarantined && !simpleData.maintainer) {
        log(`  [pypi.org] Package is quarantined, trying headless browser...`);
        const puppeteerData = await scrapePyPIWithPuppeteer(packageName);

        if (puppeteerData) {
            // Merge puppeteer data with simple data (puppeteer has author, simple has download URLs)
            return {
                ...puppeteerData,
                downloadUrls: simpleData.downloadUrls || puppeteerData.downloadUrls,
                isQuarantined: true
            };
        }

        // Puppeteer failed, return simple data with note
        log(`  [pypi.org] Note: Install puppeteer for full quarantined package data`);
        return simpleData;
    }

    if (simpleData) {
        return simpleData;
    }

    return null;
}

/**
 * Scrape PyPI download page for package files
 * @param {string} packageName - The package name
 * @param {string} version - The specific version to get files for (optional)
 * @returns {Promise<Array>} - Array of { url, filename, version }
 */
/**
 * Fetch download URLs for a specific version from PyPI
 * Uses Simple API which works for all packages including quarantined ones
 * @param {string} packageName - The package name
 * @param {string} version - The specific version to get files for (optional, filters results)
 * @returns {Promise<Array>} - Array of { url, filename, version }
 */
async function scrapePyPIDownloadPage(packageName, version = null) {
    // Use Simple API to get all download URLs
    const simpleData = await fetchPyPISimpleApi(packageName);

    if (!simpleData || !simpleData.downloadUrls || simpleData.downloadUrls.length === 0) {
        return [];
    }

    // If version specified, filter to that version only
    if (version) {
        const filtered = simpleData.downloadUrls.filter(f => f.version === version);
        if (filtered.length > 0) {
            return filtered;
        }
        // If no exact match, return all (caller will handle)
    }

    return simpleData.downloadUrls;
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
                return v.dist && v.dist.tarball && isSecurityPlaceholderTarball(v.dist.tarball);
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

function getLastVersions(packageData, count, targetVersion = null) {
    if (!packageData || !packageData.versions) {
        return [];
    }

    try {
        const allVersions = Object.keys(packageData.versions);

        let selected;
        if (targetVersion) {
            if (!allVersions.includes(targetVersion)) {
                return { notFound: true, available: allVersions };
            }
            selected = [targetVersion];
        } else {
            allVersions.sort(compareVersions);
            selected = allVersions.slice(0, count);
        }

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
            if (urlFilename && (urlFilename.endsWith('.tgz') || urlFilename.endsWith('.tar.gz') || urlFilename.endsWith('.whl') || urlFilename.endsWith('.zip') || urlFilename.endsWith('.gem'))) {
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

async function getPackageMetadata(registry, packageName, isTencent = false, targetVersion = null) {
    const maxAttempts = isTencent ? 10 : 1;
    const queryName = targetVersion ? `${packageName}@${targetVersion}` : packageName;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (isTencent && attempt > 1) {
                log(`  [Tencent] Retry attempt ${attempt}/${maxAttempts}...`);
            }

            const registryUrl = registry.replace(/\/$/, '');
            const { stdout } = await execPromise(
                `npm view ${queryName} --json --registry ${registryUrl} 2>/dev/null`,
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

async function displayPackageData(packageName, targetVersion = null) {
    showBanner();

    log(`Fetching package metadata for: ${packageName}${targetVersion ? `@${targetVersion}` : ''}\n`);

    let foundRegistry = null;
    let metadata = null;
    let isSecurityPlaceholder = false;
    const allDiscoveredVersions = new Set();

    for (const registry of REGISTRIES) {
        log(`Checking ${registry}...`);

        const isTencent = registry.includes('tencent.com');
        const registryMetadata = await getPackageMetadata(registry, packageName, isTencent, targetVersion);
        
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
        if (targetVersion) {
            // Try to fetch the full versions list so we can show what was actually available
            for (const registry of REGISTRIES) {
                const isTencent = registry.includes('tencent.com');
                const fullData = await getPackageInfo(registry, packageName, isTencent);
                if (fullData && fullData.versions) {
                    for (const v of Object.keys(fullData.versions)) allDiscoveredVersions.add(v);
                    break;
                }
            }
            if (allDiscoveredVersions.size > 0) {
                const sorted = Array.from(allDiscoveredVersions).sort(compareVersions);
                log(`\nVersion ${targetVersion} not found for ${packageName}.`);
                log(`Available versions: ${sorted.slice(0, 30).join(', ')}${sorted.length > 30 ? ` (+${sorted.length - 30} more)` : ''}`);
                process.exit(1);
            }
        }
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
async function displayPyPIPackageData(packageName, targetVersion = null) {
    showBanner();

    log(`Fetching PyPI package metadata for: ${packageName}${targetVersion ? `@${targetVersion}` : ''}\n`);
    log(`Checking ecosyste.ms...`);

    const ecosystemsData = await getEcosystemsData(packageName, 'pypi');
    let normalizedEcosystems = null;
    let scrapedData = null;
    let dataSource = 'ecosyste.ms';

    if (ecosystemsData) {
        normalizedEcosystems = normalizeEcosystemsData(ecosystemsData);
        if (normalizedEcosystems) {
            log(`  [ecosyste.ms] Package data retrieved successfully`);
        }
    }

    // Fallback to web scraping if ecosyste.ms has no data
    if (!normalizedEcosystems || (!normalizedEcosystems.latestVersion && !normalizedEcosystems.maintainers?.length)) {
        log(`\nNo data from ecosyste.ms, trying pypi.org web scraping...`);
        scrapedData = await scrapePyPIProjectPage(packageName);

        if (scrapedData) {
            dataSource = 'pypi.org';
        }
    }

    // If we still have no data
    if (!normalizedEcosystems && !scrapedData) {
        log("\nFailed to retrieve package metadata from any source");
        process.exit(1);
    }

    // If a target version was specified, verify it exists
    if (targetVersion) {
        let availableVersions = [];
        const ecosystemsVersions = await fetchEcosystemsVersions(packageName, 'pypi');
        if (Array.isArray(ecosystemsVersions)) {
            availableVersions = ecosystemsVersions.map(v => v.number).filter(Boolean);
        }
        if (availableVersions.length === 0 && scrapedData && scrapedData.downloadUrls) {
            const versionSet = new Set();
            for (const file of scrapedData.downloadUrls) {
                const m = file.filename && file.filename.match(/-(\d+\.\d+(?:\.\d+)?(?:[\w.-]*)?)(?:\.tar\.gz|\.whl|\.zip|-py)/);
                if (m) versionSet.add(m[1]);
            }
            if (scrapedData.version) versionSet.add(scrapedData.version);
            availableVersions = Array.from(versionSet);
        }
        if (!availableVersions.includes(targetVersion)) {
            log(`\nVersion ${targetVersion} not found for ${packageName}.`);
            if (availableVersions.length > 0) {
                log(`Available versions: ${availableVersions.slice(0, 30).join(', ')}${availableVersions.length > 30 ? ` (+${availableVersions.length - 30} more)` : ''}`);
            }
            process.exit(1);
        }
    }

    // Output the data
    if (SILENT_MODE) {
        let jsonOutput;

        if (scrapedData && (!normalizedEcosystems || !normalizedEcosystems.latestVersion)) {
            // Use scraped data as primary source
            jsonOutput = {
                package: packageName,
                version: targetVersion || scrapedData.version,
                description: scrapedData.description,
                maintainer: scrapedData.maintainer,
                maintainerEmail: null,
                maintainerUrl: scrapedData.maintainerUrl,
                maintainers: scrapedData.maintainer ? [{ name: scrapedData.maintainer, email: null }] : [],
                repository: null,
                license: null,
                downloads: null,
                dependentPackages: null,
                dependentRepos: null,
                firstPublished: null,
                lastPublished: null,
                downloadUrls: scrapedData.downloadUrls,
                isQuarantined: scrapedData.isQuarantined,
                source: 'pypi.org',
                registry: 'pypi'
            };
        } else {
            // Use ecosyste.ms data as primary source
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

            jsonOutput = {
                package: packageName,
                version: targetVersion || normalizedEcosystems.latestVersion,
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
                source: 'ecosyste.ms',
                registry: 'pypi'
            };
        }
        console.log(JSON.stringify(jsonOutput, null, 2));
        process.exit(0);
    }

    // Human-readable output
    if (scrapedData && scrapedData.isQuarantined) {
        log(`\n⚠️  This package has been quarantined by PyPI administrators`);
        log(`   Package data recovered from pypi.org:\n`);
    }

    if (scrapedData && (!normalizedEcosystems || !normalizedEcosystems.latestVersion)) {
        // Display scraped data
        log(`\nPackage: ${packageName}`);
        log(`Version: ${targetVersion || scrapedData.version || 'Unknown'}`);
        if (scrapedData.description) {
            log(`Description: ${scrapedData.description}`);
        }
        log('');

        if (scrapedData.maintainer) {
            log(`Maintainer: ${scrapedData.maintainer}`);
            if (scrapedData.maintainerUrl) {
                log(`  Profile: ${scrapedData.maintainerUrl}`);
            }
        }

        if (scrapedData.downloadUrls && scrapedData.downloadUrls.length > 0) {
            log('');
            log(`Download files:`);
            scrapedData.downloadUrls.forEach((file, index) => {
                log(`  ${index + 1}. ${file.filename}`);
            });
        }

        log('');
        log(`Data from: pypi.org (web scraping)`);
    } else {
        // Display ecosyste.ms data
        log(`\nPackage: ${packageName}`);
        log(`Version: ${targetVersion || normalizedEcosystems.latestVersion || 'Unknown'}`);
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
    }

    process.exit(0);
}

/**
 * Download PyPI packages using ecosyste.ms version data
 * @param {string} packageName - The package name
 * @param {number} versionCount - Number of versions to download
 * @param {string} outputPath - Directory to save files
 * @param {string|null} gcpCredentials - Optional path to GCP service account JSON for BigQuery fallback
 */
function pickVersions(versions, count, targetVersion, sourceLabel) {
    if (targetVersion) {
        const match = versions.find(v => v.number === targetVersion);
        if (!match) {
            const available = versions.map(v => v.number);
            log(`  [${sourceLabel}] Version ${targetVersion} not found. Available: ${available.slice(0, 30).join(', ')}${available.length > 30 ? ` (+${available.length - 30} more)` : ''}`);
            return [];
        }
        return [match];
    }
    return versions.slice(0, count);
}

async function downloadPyPIPackages(packageName, versionCount, outputPath, gcpCredentials = null, targetVersion = null) {
    showBanner();

    log(`Searching for PyPI package: ${packageName}`);
    if (targetVersion) {
        log(`Target version: ${targetVersion}`);
    } else {
        log(`Requesting ${versionCount} version(s)`);
    }
    log(`Output directory: ${outputPath}\n`);

    log(`Checking ecosyste.ms for package versions...`);

    // Fetch versions from ecosyste.ms
    let versions = await fetchEcosystemsVersions(packageName, 'pypi');
    let selectedVersions = [];
    let usedBigQueryAsPrimary = false;
    let usedWebScrapingAsPrimary = false;

    if (!versions || versions.length === 0) {
        // ecosyste.ms has no data - try BigQuery as fallback
        if (gcpCredentials) {
            log(`\nNo versions found on ecosyste.ms, trying BigQuery...`);
            const bigqueryResults = await fetchPyPIUrlsFromBigQuery(packageName, gcpCredentials);

            if (bigqueryResults.length > 0) {
                // Convert BigQuery results to version objects and dedupe by version
                const versionMap = new Map();
                for (const r of bigqueryResults) {
                    // Prefer .tar.gz over .whl for source packages
                    if (!versionMap.has(r.version) || r.filename.endsWith('.tar.gz')) {
                        versionMap.set(r.version, {
                            number: r.version,
                            download_url: r.url,
                            filename: r.filename
                        });
                    }
                }

                // Sort by version (semver-like) and take requested count
                versions = Array.from(versionMap.values());
                versions.sort((a, b) => compareVersions(a.number, b.number));
                selectedVersions = pickVersions(versions, versionCount, targetVersion, 'BigQuery');
                if (selectedVersions.length > 0) {
                    usedBigQueryAsPrimary = true;

                    log(`  [BigQuery] Found ${versionMap.size} version(s), downloading ${selectedVersions.length}:`);
                    selectedVersions.forEach(v => log(`    - ${v.number}`));
                    log('');
                }
            }
        }

        // If still no versions, try web scraping as final fallback
        if (selectedVersions.length === 0) {
            log(`\nNo versions from ecosyste.ms${gcpCredentials ? ' or BigQuery' : ''}, trying pypi.org web scraping...`);
            const scrapedData = await scrapePyPIProjectPage(packageName);

            if (scrapedData && scrapedData.downloadUrls && scrapedData.downloadUrls.length > 0) {
                // Convert scraped URLs to version objects
                const versionMap = new Map();
                for (const file of scrapedData.downloadUrls) {
                    // Extract version from filename
                    const versionMatch = file.filename.match(/-(\d+\.\d+(?:\.\d+)?(?:[\w.-]*)?)(?:\.tar\.gz|\.whl|\.zip|-py)/);
                    const version = versionMatch ? versionMatch[1] : scrapedData.version;

                    if (version) {
                        // Prefer .tar.gz over .whl
                        if (!versionMap.has(version) || file.filename.endsWith('.tar.gz')) {
                            versionMap.set(version, {
                                number: version,
                                download_url: file.url,
                                filename: file.filename
                            });
                        }
                    }
                }

                if (versionMap.size > 0) {
                    versions = Array.from(versionMap.values());
                    versions.sort((a, b) => compareVersions(a.number, b.number));
                    selectedVersions = pickVersions(versions, versionCount, targetVersion, 'pypi.org');
                    if (selectedVersions.length > 0) {
                        usedWebScrapingAsPrimary = true;

                        if (scrapedData.isQuarantined) {
                            log(`  ⚠️  Package is quarantined by PyPI administrators`);
                        }
                        log(`  [pypi.org] Found ${versionMap.size} version(s), downloading ${selectedVersions.length}:`);
                        selectedVersions.forEach(v => log(`    - ${v.number}`));
                        log('');
                    }
                }
            } else if (scrapedData && scrapedData.version) {
                // We have version info but no download URLs on main page, try download page
                if (targetVersion && scrapedData.version !== targetVersion) {
                    log(`  [pypi.org] Version ${targetVersion} not found. Available: ${scrapedData.version}`);
                } else {
                const versionToFetch = targetVersion || scrapedData.version;
                log(`  Trying to fetch download page for version ${versionToFetch}...`);
                const downloadFiles = await scrapePyPIDownloadPage(packageName, versionToFetch);

                if (downloadFiles.length > 0) {
                    // Prefer .tar.gz files
                    const tarGz = downloadFiles.find(f => f.filename.endsWith('.tar.gz'));
                    const selectedFile = tarGz || downloadFiles[0];

                    selectedVersions = [{
                        number: versionToFetch,
                        download_url: selectedFile.url,
                        filename: selectedFile.filename
                    }];
                    usedWebScrapingAsPrimary = true;

                    if (scrapedData.isQuarantined) {
                        log(`  ⚠️  Package is quarantined by PyPI administrators`);
                    }
                    log(`  [pypi.org] Found download for version ${versionToFetch}`);
                    log('');
                }
                }
            }
        }

        // If still nothing found, exit with error
        if (selectedVersions.length === 0) {
            log(`\nNo matching versions found for ${packageName}${targetVersion ? '@' + targetVersion : ''}`);
            if (!gcpCredentials) {
                log(`Tip: Use --gcp-credentials to enable BigQuery fallback for deleted packages.\n`);
            }
            process.exit(1);
        }
    } else {
        // ecosyste.ms found versions - sort and select
        versions.sort((a, b) => {
            const dateA = new Date(a.published_at || 0);
            const dateB = new Date(b.published_at || 0);
            return dateB - dateA;
        });

        selectedVersions = pickVersions(versions, versionCount, targetVersion, 'ecosyste.ms');

        if (selectedVersions.length === 0) {
            log(`\nNo matching versions found for ${packageName}${targetVersion ? '@' + targetVersion : ''}`);
            process.exit(1);
        }

        log(`  Found ${versions.length} total version(s), downloading ${selectedVersions.length}:`);
        selectedVersions.forEach(v => log(`    - ${v.number}`));
        log('');

        // Check if any versions are missing download URLs
        const versionsWithoutUrls = selectedVersions.filter(v => !v.download_url);

        // Try BigQuery fallback if we have versions without URLs and credentials provided
        if (versionsWithoutUrls.length > 0 && gcpCredentials) {
            log(`Some versions missing download URLs, trying BigQuery fallback...`);
            const bigqueryResults = await fetchPyPIUrlsFromBigQuery(packageName, gcpCredentials);

            // Merge BigQuery URLs into version data
            for (const v of versionsWithoutUrls) {
                const bqMatch = bigqueryResults.find(r => r.version === v.number);
                if (bqMatch) {
                    v.download_url = bqMatch.url;
                    log(`  [BigQuery] Found URL for version ${v.number}`);
                }
            }
            log('');
        }

        // Try web scraping for versions still missing URLs
        const stillMissingUrls = selectedVersions.filter(v => !v.download_url);
        if (stillMissingUrls.length > 0) {
            log(`Trying pypi.org web scraping for ${stillMissingUrls.length} version(s) missing URLs...`);
            for (const v of stillMissingUrls) {
                const downloadFiles = await scrapePyPIDownloadPage(packageName, v.number);
                if (downloadFiles.length > 0) {
                    // Prefer .tar.gz files
                    const tarGz = downloadFiles.find(f => f.filename.endsWith('.tar.gz'));
                    const selectedFile = tarGz || downloadFiles[0];
                    v.download_url = selectedFile.url;
                    log(`  [pypi.org] Found URL for version ${v.number}`);
                }
            }
            log('');
        }

        const finalMissingUrls = selectedVersions.filter(v => !v.download_url);
        if (finalMissingUrls.length > 0 && !gcpCredentials) {
            log(`Note: ${finalMissingUrls.length} version(s) still missing download URLs.`);
            log(`      Use --gcp-credentials or GCP_CREDENTIALS env var to enable BigQuery fallback.\n`);
        }
    }

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
        const source = usedWebScrapingAsPrimary ? 'pypi.org (web scraping)' :
                       usedBigQueryAsPrimary ? 'BigQuery' : 'files.pythonhosted.org';
        log(`\nSuccessfully downloaded ${successCount} version(s) from ${source}`);
        process.exit(0);
    } else {
        log(`\nFailed to download any versions`);
        process.exit(1);
    }
}

// ==========================================
// RubyGems download + data
// ==========================================

/**
 * Try downloading a single .gem: primary URL first (usually the ecosyste.ms-
 * supplied rubygems.org/downloads/... URL), then each Chinese mirror in order.
 * @param {string} packageName
 * @param {string} version
 * @param {string|null} primaryUrl
 * @param {string} outputPath
 * @returns {Promise<{ok: boolean, source: string|null}>}
 */
async function downloadGemArtifact(packageName, version, primaryUrl, outputPath) {
    const filename = `${packageName}-${version}.gem`;
    const attempts = [];
    if (primaryUrl) attempts.push({ url: primaryUrl, label: 'rubygems.org' });
    for (const template of GEM_MIRRORS) {
        const url = template
            .replace('{name}', encodeURIComponent(packageName))
            .replace('{version}', encodeURIComponent(version));
        const host = new URL(url).host;
        attempts.push({ url, label: host });
    }

    for (const { url, label } of attempts) {
        try {
            log(`  [${label}] Downloading ${filename}...`);
            await performDownload(url, packageName, version, outputPath, 0, filename);
            return { ok: true, source: label };
        } catch (e) {
            log(`    [${label}] ${e.message}`);
        }
    }

    return { ok: false, source: null };
}

async function downloadRubygemsPackages(packageName, versionCount, outputPath, targetVersion = null) {
    showBanner();

    log(`Searching for RubyGems package: ${packageName}`);
    if (targetVersion) {
        log(`Target version: ${targetVersion}`);
    } else {
        log(`Requesting ${versionCount} version(s)`);
    }
    log(`Output directory: ${outputPath}\n`);

    log(`Checking ecosyste.ms for package versions...`);
    const versions = await fetchEcosystemsVersions(packageName, 'rubygems');

    if (!versions || versions.length === 0) {
        log(`\nNo versions found on ecosyste.ms for ${packageName}`);
        process.exit(1);
    }

    versions.sort((a, b) => {
        const dateA = new Date(a.published_at || 0);
        const dateB = new Date(b.published_at || 0);
        return dateB - dateA;
    });

    const selectedVersions = pickVersions(versions, versionCount, targetVersion, 'ecosyste.ms');

    if (selectedVersions.length === 0) {
        log(`\nNo matching versions found for ${packageName}${targetVersion ? '@' + targetVersion : ''}`);
        process.exit(1);
    }

    log(`  Found ${versions.length} total version(s), downloading ${selectedVersions.length}:`);
    selectedVersions.forEach(v => log(`    - ${v.number}${v.yanked ? ' (yanked)' : ''}`));
    log('');

    let successCount = 0;
    let anyYankedMissed = false;

    for (const v of selectedVersions) {
        log(`\n=== ${packageName}@${v.number} ===`);
        const primaryUrl = v.download_url || null;
        const result = await downloadGemArtifact(packageName, v.number, primaryUrl, outputPath);
        if (result.ok) {
            successCount++;
            log(`  Recovered via: ${result.source}`);
        } else {
            log(`  Failed to recover ${packageName}@${v.number} from any source`);
            if (v.yanked) anyYankedMissed = true;
        }
    }

    log('');
    if (successCount > 0) {
        log(`Successfully downloaded ${successCount}/${selectedVersions.length} version(s)`);
        process.exit(0);
    }

    log(`Failed to download any versions from rubygems.org or Chinese mirrors`);
    if (anyYankedMissed) {
        log(`Tip: yanked gems may only be recoverable via --socket (source-file reconstruction from socket.dev)`);
    }
    process.exit(1);
}

async function displayRubygemsPackageData(packageName, targetVersion = null) {
    showBanner();

    log(`Fetching RubyGems package metadata for: ${packageName}${targetVersion ? `@${targetVersion}` : ''}\n`);
    log(`Checking ecosyste.ms...`);

    const ecosystemsData = await getEcosystemsData(packageName, 'rubygems');
    const normalized = ecosystemsData ? normalizeEcosystemsData(ecosystemsData) : null;

    if (!normalized) {
        log("\nFailed to retrieve package metadata from ecosyste.ms");
        process.exit(1);
    }

    log(`  [ecosyste.ms] Package data retrieved successfully`);

    if (targetVersion) {
        const versions = await fetchEcosystemsVersions(packageName, 'rubygems');
        const available = Array.isArray(versions) ? versions.map(v => v.number).filter(Boolean) : [];
        if (!available.includes(targetVersion)) {
            log(`\nVersion ${targetVersion} not found for ${packageName}.`);
            if (available.length > 0) {
                log(`Available versions: ${available.slice(0, 30).join(', ')}${available.length > 30 ? ` (+${available.length - 30} more)` : ''}`);
            }
            process.exit(1);
        }
    }

    const versionToShow = targetVersion || normalized.latestVersion;

    if (SILENT_MODE) {
        let maintainers = [];
        let primaryUser = null;
        let primaryEmail = null;
        if (normalized.maintainers && normalized.maintainers.length > 0) {
            maintainers = normalized.maintainers.map(m => ({ name: m.name || null, email: m.email || null }));
            primaryUser = normalized.maintainers[0].name || null;
            primaryEmail = normalized.maintainers[0].email || null;
        }

        const jsonOutput = {
            package: packageName,
            version: versionToShow,
            description: normalized.description,
            maintainer: primaryUser,
            maintainerEmail: primaryEmail,
            maintainers,
            repository: normalized.repository,
            license: normalized.license,
            downloads: normalized.downloads,
            dependentPackages: normalized.dependentPackages,
            dependentRepos: normalized.dependentRepos,
            firstPublished: normalized.firstPublished,
            lastPublished: normalized.lastPublished,
            source: 'ecosyste.ms',
            registry: 'rubygems'
        };
        console.log(JSON.stringify(jsonOutput, null, 2));
        process.exit(0);
    }

    log(`\nPackage: ${packageName}`);
    log(`Version: ${versionToShow || 'Unknown'}`);
    if (normalized.description) log(`Description: ${normalized.description}`);
    log('');

    if (normalized.downloads !== null && normalized.downloads !== undefined) {
        log(`Downloads (last month): ${normalized.downloads.toLocaleString()}`);
    }
    if (normalized.license) log(`License: ${normalized.license}`);
    if (normalized.repository) log(`Repository: ${normalized.repository}`);
    if (normalized.dependentPackages !== null && normalized.dependentPackages !== undefined) {
        log(`Dependent packages: ${normalized.dependentPackages.toLocaleString()}`);
    }
    if (normalized.dependentRepos !== null && normalized.dependentRepos !== undefined) {
        log(`Dependent repos: ${normalized.dependentRepos.toLocaleString()}`);
    }
    if (normalized.firstPublished) log(`First published: ${normalized.firstPublished}`);
    if (normalized.lastPublished) log(`Last published: ${normalized.lastPublished}`);

    if (normalized.maintainers && normalized.maintainers.length > 0) {
        log('');
        log(`Maintainers:`);
        normalized.maintainers.forEach((m, i) => {
            log(`  ${i + 1}. ${m.name}`);
            if (m.email) log(`     Email: ${m.email}`);
            if (m.packagesCount) log(`     Packages: ${m.packagesCount}`);
            if (m.htmlUrl) log(`     Profile: ${m.htmlUrl}`);
        });
    }

    log('');
    log(`Data from: ecosyste.ms (rubygems.org)`);
    process.exit(0);
}

// ==========================================
// NPM CLI Fallback Method
// ==========================================

async function tryNpmViewMethod(packageName, versionCount, outputPath, targetVersion = null) {
    log(`\nTrying npm view CLI method with Chinese mirrors...`);

    for (const registry of NPM_VIEW_REGISTRIES) {
        log(`\nChecking ${registry} via npm view...`);

        try {
            const queryName = targetVersion ? `${packageName}@${targetVersion}` : packageName;
            const command = `npm view ${queryName} --json --registry ${registry}`;
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

            let selectedVersions;
            if (targetVersion) {
                const match = versions.find(v => v.version === targetVersion);
                if (!match) {
                    log(`  Version ${targetVersion} not found via npm view`);
                    continue;
                }
                selectedVersions = [match];
            } else {
                versions.sort((a, b) => compareVersions(a.version, b.version));
                selectedVersions = versions.slice(0, versionCount);
            }
            
            const validTarballs = [];
            for (const versionData of selectedVersions) {
                if (versionData.dist && versionData.dist.tarball) {
                    const tarball = versionData.dist.tarball;
                    
                    // Skip security placeholder tarballs
                    if (!isSecurityPlaceholderTarball(tarball)) {
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

// ==========================================
// kmsec.uk DPRK Research Archive
// ==========================================

/**
 * Fetch the kmsec.uk package listing and find entries for a given package
 * @param {string} packageName - The package name to search for
 * @returns {Promise<Array>} - Array of matching entries with { name, version, released_date, npm_user, npm_email }
 */
async function fetchKmsecPackageListing(packageName) {
    return new Promise((resolve) => {
        log(`  [kmsec.uk] Fetching package listing...`);

        const request = https.get(KMSEC_LISTING, { timeout: 15000 }, (response) => {
            if (response.statusCode === 200) {
                let data = '';
                response.on('data', chunk => data += chunk);
                response.on('end', () => {
                    try {
                        const entries = JSON.parse(data);
                        // Filter for matching package name (case-insensitive)
                        const matches = entries.filter(e =>
                            e.name && e.name.toLowerCase() === packageName.toLowerCase()
                        );
                        resolve(matches);
                    } catch (e) {
                        log(`  [kmsec.uk] Error parsing JSON listing`);
                        resolve([]);
                    }
                });
            } else {
                log(`  [kmsec.uk] Listing HTTP ${response.statusCode}`);
                resolve([]);
            }
        });

        request.on('error', (e) => {
            log(`  [kmsec.uk] Connection error: ${e.message}`);
            resolve([]);
        });

        request.on('timeout', () => {
            request.destroy();
            log(`  [kmsec.uk] Request timeout`);
            resolve([]);
        });
    });
}

/**
 * Try to download a single npm package version from kmsec.uk research archive
 * @param {string} packageName - The package name
 * @param {string} version - The package version
 * @param {string} outputPath - Directory to save files
 * @returns {Promise<boolean>} - True if download succeeded
 */
async function tryKmsecDownload(packageName, version, outputPath) {
    const url = `${KMSEC_API}${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

    log(`  [kmsec.uk] Downloading ${packageName}@${version}...`);

    try {
        const success = await performDownload(url, packageName, version, outputPath);
        if (success) {
            return true;
        }
    } catch (e) {
        log(`  [kmsec.uk] Failed: ${e.message}`);
    }

    return false;
}

/**
 * Try kmsec.uk as a fallback source for npm packages
 * First queries the listing API to find available versions, then downloads them
 * @param {string} packageName - The package name
 * @param {Array} knownVersions - Array of version strings discovered from other sources (used as fallback)
 * @param {number} versionCount - Max number of versions to download
 * @param {string} outputPath - Directory to save files
 * @returns {Promise<boolean>} - True if any downloads succeeded
 */
async function tryKmsecMethod(packageName, knownVersions, versionCount, outputPath) {
    log(`\nTrying kmsec.uk DPRK research archive...`);

    // Query the kmsec.uk listing to find available versions
    const kmsecEntries = await fetchKmsecPackageListing(packageName);

    let versionsToTry = [];

    if (kmsecEntries.length > 0) {
        // Sort by release date (newest first)
        kmsecEntries.sort((a, b) => (b.released || 0) - (a.released || 0));

        // Dedupe by version
        const seen = new Set();
        for (const entry of kmsecEntries) {
            if (entry.version && !seen.has(entry.version)) {
                seen.add(entry.version);
                versionsToTry.push(entry.version);
            }
        }

        log(`  [kmsec.uk] Found ${versionsToTry.length} version(s) in archive`);
    } else {
        // Package not in listing — try known versions as fallback
        if (knownVersions && knownVersions.length > 0) {
            versionsToTry = knownVersions;
            log(`  [kmsec.uk] Not in listing, trying ${versionsToTry.length} known version(s)...`);
        } else {
            log(`  [kmsec.uk] Package not found in archive`);
            return false;
        }
    }

    const toTry = versionsToTry.slice(0, versionCount);
    log(`  Downloading ${toTry.length} version(s): ${toTry.join(', ')}`);

    let successCount = 0;
    for (const version of toTry) {
        const success = await tryKmsecDownload(packageName, version, outputPath);
        if (success) {
            successCount++;
        }
    }

    if (successCount > 0) {
        log(`\nSuccessfully downloaded ${successCount} version(s) from kmsec.uk`);
        return true;
    }

    log(`  [kmsec.uk] Failed to download any versions`);
    return false;
}

// ==========================================
// socket.dev source (Puppeteer-only, npm)
// ==========================================

/**
 * Launch a Puppeteer browser suitable for socket.dev (Cloudflare-protected).
 * Reuses the same launch conventions as scrapePyPIWithPuppeteer.
 * @returns {Promise<{browser: Object}>}
 * @throws {Error} if puppeteer or a browser binary cannot be found
 */
async function launchSocketBrowser() {
    const puppeteer = tryLoadPuppeteer();
    if (!puppeteer) {
        throw new Error("puppeteer is not installed. Install with: npm install -g puppeteer");
    }

    const launchOptions = {
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled'
        ]
    };

    // Prefer puppeteer's bundled browser (guaranteed protocol match). Fall back to
    // system Chrome only when puppeteer-core is installed instead.
    if (puppeteer.executablePath && typeof puppeteer.executablePath === 'function') {
        try {
            launchOptions.executablePath = puppeteer.executablePath();
        } catch (e) {}
    }
    if (!launchOptions.executablePath) {
        const systemChrome = findChromePath();
        if (systemChrome) launchOptions.executablePath = systemChrome;
    }
    if (!launchOptions.executablePath) {
        throw new Error("No Chrome/Chromium found. Install Chrome or run: npm install -g puppeteer");
    }

    const browser = await puppeteer.launch(launchOptions);
    return { browser };
}

/**
 * Configure a page with a realistic UA and hide common automation fingerprints
 * before navigating socket.dev (Cloudflare-protected).
 * @param {Object} page - Puppeteer page
 */
async function prepareSocketPage(page) {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"'
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
        // Hide the automation signals Cloudflare fingerprints hardest.
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
        const origQuery = window.navigator.permissions && window.navigator.permissions.query;
        if (origQuery) {
            window.navigator.permissions.query = (p) =>
                p && p.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery(p);
        }
    });
}

/**
 * Warm the browser session by loading socket.dev's root once so Cloudflare
 * sets the __cf_bm cookie for the whole domain before we try deeper pages.
 * @param {Object} page - Puppeteer page
 */
async function warmSocketSession(page) {
    log(`  [socket.dev] Warming session at ${SOCKET_BASE}/ ...`);
    try {
        await page.goto(SOCKET_BASE + '/', { waitUntil: 'networkidle2', timeout: 45000 });
        if (await isCloudflareChallenge(page)) {
            await waitForCloudflareClear(page, 45000);
        }
    } catch (e) {
        // Non-fatal — subsequent nav will retry the challenge with the same context.
    }
}

/**
 * Detect Cloudflare's "Just a moment..." challenge page.
 * @param {Object} page - Puppeteer page
 * @returns {Promise<boolean>}
 */
async function isCloudflareChallenge(page) {
    try {
        const title = await page.title();
        return typeof title === 'string' && title.trim().toLowerCase().startsWith('just a moment');
    } catch (e) {
        return false;
    }
}

/**
 * Wait up to `timeoutMs` for a Cloudflare managed challenge to resolve.
 * Cloudflare typically clears the challenge on its own within a few seconds when
 * the browser looks legitimate; we just have to sit still and let it happen.
 * @param {Object} page - Puppeteer page
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} - true if the challenge cleared
 */
async function waitForCloudflareClear(page, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!(await isCloudflareChallenge(page))) return true;
        await new Promise(r => setTimeout(r, 1000));
    }
    return !(await isCloudflareChallenge(page));
}

/**
 * Discover available versions on socket.dev for an npm package.
 * @param {Object} page - Puppeteer page
 * @param {string} packageName
 * @returns {Promise<string[]>} - Versions sorted newest-first, with security placeholders removed
 */
async function discoverSocketVersions(page, packageName, socketRegistry = 'npm') {
    const url = `${SOCKET_BASE}/${socketRegistry}/package/${packageName}/versions`;
    log(`  [socket.dev] Fetching versions list: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    if (await isCloudflareChallenge(page)) {
        log(`  [socket.dev] Cloudflare challenge — waiting to clear...`);
        if (!(await waitForCloudflareClear(page))) {
            throw new Error("socket.dev Cloudflare challenge did not clear within 45s. Re-run the command; if it keeps happening, upgrade puppeteer: `npm install -g puppeteer@latest`.");
        }
    }

    const versions = await page.evaluate((pkgName, registry) => {
        const found = new Set();
        // Anchor tags to /<registry>/package/<name>/overview/<v> or /files/<v> both encode the version.
        const anchors = document.querySelectorAll('a[href]');
        const prefixes = [
            `/${registry}/package/${pkgName}/overview/`,
            `/${registry}/package/${pkgName}/files/`
        ];
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            for (const prefix of prefixes) {
                if (href.startsWith(prefix)) {
                    const rest = href.slice(prefix.length).split(/[/?#]/)[0];
                    if (rest) found.add(decodeURIComponent(rest));
                }
            }
        }
        return Array.from(found);
    }, packageName, socketRegistry);

    const cleaned = versions.filter(v => v && !isSecurityPlaceholderVersion(v));
    cleaned.sort(compareVersions);

    if (cleaned.length === 0) {
        log(`  [socket.dev] No versions parsed from versions page`);
    } else {
        log(`  [socket.dev] Found ${cleaned.length} version(s) on socket.dev`);
    }
    return cleaned;
}

/**
 * Load the file tree for a package version from Socket's SSR JSON island.
 * The __NEXT_DATA__ script embeds every file's relative path + content hash,
 * which lets us fetch bodies directly from socketusercontent.com without
 * further Puppeteer navigation.
 * @param {Object} page - Puppeteer page (already past Cloudflare)
 * @param {string} packageName
 * @param {string} version
 * @returns {Promise<Array<{path: string, hash: string, size: number}>>}
 */
async function discoverSocketFileTree(page, packageName, version, socketRegistry = 'npm') {
    const url = `${SOCKET_BASE}/${socketRegistry}/package/${packageName}/files/${encodeURIComponent(version)}`;
    log(`  [socket.dev] Loading file tree: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    if (await isCloudflareChallenge(page)) {
        log(`  [socket.dev] Cloudflare challenge — waiting to clear...`);
        if (!(await waitForCloudflareClear(page))) {
            throw new Error("socket.dev Cloudflare challenge did not clear within 45s");
        }
    }

    const files = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        if (!el) return null;
        try {
            const data = JSON.parse(el.textContent || '{}');
            const arr = data && data.props && data.props.pageProps && data.props.pageProps.files;
            if (!Array.isArray(arr)) return null;
            return arr
                .filter(f => f && f.type === 'file' && typeof f.path === 'string' && typeof f.hash === 'string')
                .map(f => ({ path: f.path, hash: f.hash, size: typeof f.size === 'number' ? f.size : 0 }));
        } catch (e) {
            return null;
        }
    });

    if (!files || files.length === 0) {
        log(`  [socket.dev] No files found in __NEXT_DATA__ for ${packageName}@${version}`);
        return [];
    }

    log(`  [socket.dev] File tree: ${files.length} file(s)`);
    return files;
}

/**
 * Fetch a raw file body from socket.dev's content-addressed CDN.
 * These URLs are public and not Cloudflare-protected — plain https.get works.
 * @param {string} hash - Content hash from a file-tree entry
 * @returns {Promise<Buffer>}
 */
function fetchSocketBlob(hash) {
    const url = SOCKET_BLOB_BASE + encodeURIComponent(hash);
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': 'undelete/' + VERSION,
                'Accept': '*/*'
            }
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for blob ${hash}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`timeout fetching blob ${hash}`));
        });
    });
}

/**
 * Package a fetched file tree into <pkg>-<version>.tgz using system tar.
 * @param {string} packageName
 * @param {string} version
 * @param {Map<string,string>} files - relPath -> text content
 * @param {string} outputPath - Destination directory for the tgz
 * @returns {Promise<string>} - Absolute path of the created tgz
 */
async function writeAndPackageSocket(packageName, version, files, outputPath) {
    const safeName = packageName.replace('/', '-');
    const workRoot = path.join(outputPath, `.socket-work-${safeName}-${version}-${process.pid}`);
    const packageDir = path.join(workRoot, 'package');
    fs.mkdirSync(packageDir, { recursive: true });

    try {
        for (const [relPath, content] of files.entries()) {
            const dest = path.join(packageDir, relPath);
            const parent = path.dirname(dest);
            const resolvedParent = path.resolve(parent);
            const resolvedPackageDir = path.resolve(packageDir);
            if (!resolvedParent.startsWith(resolvedPackageDir)) {
                throw new Error(`Refusing to write outside package dir: ${relPath}`);
            }
            fs.mkdirSync(parent, { recursive: true });
            fs.writeFileSync(dest, content);
        }

        const tgzPath = path.join(outputPath, `${safeName}-${version}.tgz`);
        await execPromise(`tar -czf "${tgzPath}" -C "${workRoot}" package`);
        return tgzPath;
    } finally {
        try {
            fs.rmSync(workRoot, { recursive: true, force: true });
        } catch (e) {
            log(`  [socket.dev] Warning: failed to remove work dir ${workRoot}: ${e.message}`);
        }
    }
}

/**
 * Package fetched files into <name>-<version>-source.tar.gz for rubygems.
 * Uses a <name>-<version>/ prefix rather than package/ so the archive extracts
 * into a clearly-named directory. Output is NOT a valid .gem — the -source
 * suffix and .tar.gz extension make that obvious.
 */
async function writeAndPackageSocketGem(packageName, version, files, outputPath) {
    const safeName = packageName.replace('/', '-');
    const workRoot = path.join(outputPath, `.socket-work-${safeName}-${version}-${process.pid}`);
    const dirName = `${safeName}-${version}`;
    const packageDir = path.join(workRoot, dirName);
    fs.mkdirSync(packageDir, { recursive: true });

    try {
        for (const [relPath, content] of files.entries()) {
            const dest = path.join(packageDir, relPath);
            const parent = path.dirname(dest);
            const resolvedParent = path.resolve(parent);
            const resolvedPackageDir = path.resolve(packageDir);
            if (!resolvedParent.startsWith(resolvedPackageDir)) {
                throw new Error(`Refusing to write outside package dir: ${relPath}`);
            }
            fs.mkdirSync(parent, { recursive: true });
            fs.writeFileSync(dest, content);
        }

        const tgzPath = path.join(outputPath, `${safeName}-${version}-source.tar.gz`);
        await execPromise(`tar -czf "${tgzPath}" -C "${workRoot}" "${dirName}"`);
        return tgzPath;
    } finally {
        try {
            fs.rmSync(workRoot, { recursive: true, force: true });
        } catch (e) {
            log(`  [socket.dev] Warning: failed to remove work dir ${workRoot}: ${e.message}`);
        }
    }
}

/**
 * Orchestrate the socket.dev download flow for a single package.
 * @param {string} packageName
 * @param {number} versionCount
 * @param {string|null} targetVersion
 * @param {string} outputPath
 * @param {string} socketRegistry - 'npm' or 'rubygems'
 * @returns {Promise<{downloaded: string[], notFound: string[], available: string[]}>}
 */
async function trySocketMethod(packageName, versionCount, targetVersion, outputPath, socketRegistry = 'npm') {
    log(`\nTrying socket.dev (${socketRegistry})...`);

    try {
        await execPromise('tar --version');
    } catch (e) {
        throw new Error("system 'tar' not found on PATH — required to package socket.dev files");
    }

    const { browser } = await launchSocketBrowser();
    const downloaded = [];
    const notFound = [];
    let availableVersions = [];

    try {
        const page = await browser.newPage();
        await prepareSocketPage(page);
        await warmSocketSession(page);

        availableVersions = await discoverSocketVersions(page, packageName, socketRegistry);

        let versionsToFetch;
        if (targetVersion) {
            if (!availableVersions.includes(targetVersion)) {
                return { downloaded, notFound: [targetVersion], available: availableVersions };
            }
            versionsToFetch = [targetVersion];
        } else {
            versionsToFetch = availableVersions.slice(0, versionCount);
        }

        if (versionsToFetch.length === 0) {
            log(`  [socket.dev] No usable versions to fetch`);
            return { downloaded, notFound, available: availableVersions };
        }

        log(`  [socket.dev] Fetching ${versionsToFetch.length} version(s): ${versionsToFetch.join(', ')}`);

        for (const version of versionsToFetch) {
            log(`\n  [socket.dev] === ${packageName}@${version} ===`);
            const fileEntries = await discoverSocketFileTree(page, packageName, version, socketRegistry);
            if (fileEntries.length === 0) {
                log(`  [socket.dev] No files found for ${version}, skipping`);
                notFound.push(version);
                continue;
            }

            const files = new Map();
            let failed = 0;
            const CONCURRENCY = 8;
            let cursor = 0;
            const total = fileEntries.length;

            async function worker() {
                while (true) {
                    const idx = cursor++;
                    if (idx >= total) return;
                    const entry = fileEntries[idx];
                    log(`  [socket.dev] (${idx + 1}/${total}) ${entry.path} (${entry.size} bytes)`);
                    try {
                        const buf = await fetchSocketBlob(entry.hash);
                        files.set(entry.path, buf);
                    } catch (e) {
                        failed++;
                        log(`    [socket.dev] failed: ${e.message}`);
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

            if (files.size === 0) {
                log(`  [socket.dev] No file contents captured for ${version}`);
                notFound.push(version);
                continue;
            }

            const packager = socketRegistry === 'rubygems' ? writeAndPackageSocketGem : writeAndPackageSocket;
            const outPath = await packager(packageName, version, files, outputPath);
            downloaded.push(outPath);
            log(`  [socket.dev] Wrote ${outPath} (${files.size} file(s), ${failed} failed)`);
        }
    } finally {
        try { await browser.close(); } catch (e) {}
    }

    return { downloaded, notFound, available: availableVersions };
}

async function main() {
    const args = process.argv.slice(2);
    let registry = null;
    let packageName = null;
    let outputPath = process.cwd();
    let versionCount = 5;
    let dataMode = false;
    let gcpCredentials = process.env.GCP_CREDENTIALS || null;
    let targetVersion = null;
    let socketMode = false;

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
        } else if (args[i] === '--gcp-credentials') {
            if (i + 1 < args.length) {
                gcpCredentials = args[i + 1];
                i++;
            } else {
                console.log("Error: --gcp-credentials requires a path to service account JSON file");
                process.exit(1);
            }
        } else if (args[i] === '--target-version' || args[i] === '-t') {
            if (i + 1 < args.length) {
                targetVersion = args[i + 1];
                i++;
            } else {
                console.log("Error: --target-version/-t requires a version string");
                process.exit(1);
            }
        } else if (args[i] === '--socket') {
            socketMode = true;
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

    // Normalize aliases so downstream code only sees canonical names.
    if (registry === 'gem') registry = 'rubygems';

    if (!packageName) {
        console.log("Usage: undelete <registry> <package-name> [options]");
        console.log("Try 'undelete --help' for more information.");
        process.exit(1);
    }

    // --socket guards
    if (socketMode) {
        if (registry !== 'npm' && registry !== 'rubygems') {
            console.log("Error: --socket supports npm and rubygems in this release");
            process.exit(1);
        }
        if (dataMode) {
            console.log("Error: --socket cannot be combined with --data (socket.dev has no metadata endpoint)");
            process.exit(1);
        }
    }

    // socket.dev exclusive mode — skips the normal fallback chain. Registry-agnostic.
    if (socketMode) {
        if (!fs.existsSync(outputPath)) {
            console.log(`Error: Directory ${outputPath} does not exist`);
            process.exit(1);
        }
        if (!fs.statSync(outputPath).isDirectory()) {
            console.log(`Error: ${outputPath} is not a directory`);
            process.exit(1);
        }

        showBanner();
        log(`Searching for ${registry} package: ${packageName}`);
        if (targetVersion) {
            log(`Target version: ${targetVersion}`);
        } else {
            log(`Requesting ${versionCount} version(s)`);
        }
        log(`Output directory: ${outputPath}\n`);

        try {
            const result = await trySocketMethod(
                packageName,
                targetVersion ? 1 : versionCount,
                targetVersion,
                outputPath,
                registry
            );

            if (result.downloaded.length > 0) {
                log(`\nSuccessfully downloaded ${result.downloaded.length} version(s) from socket.dev`);
                process.exit(0);
            }

            if (targetVersion && result.available.length > 0) {
                const sorted = result.available.slice().sort(compareVersions);
                log(`\nVersion ${targetVersion} not found on socket.dev for ${packageName}.`);
                log(`Available versions on socket.dev: ${sorted.slice(0, 30).join(', ')}${sorted.length > 30 ? ` (+${sorted.length - 30} more)` : ''}`);
                process.exit(1);
            }

            log(`\nFailed to download any versions from socket.dev`);
            process.exit(1);
        } catch (err) {
            console.error(`socket.dev error: ${err.message}`);
            process.exit(1);
        }
    }

    // Route to appropriate handler based on registry
    if (registry === 'pypi') {
        if (dataMode) {
            await displayPyPIPackageData(packageName, targetVersion);
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

        await downloadPyPIPackages(packageName, versionCount, outputPath, gcpCredentials, targetVersion);
        return;
    }

    if (registry === 'rubygems') {
        if (dataMode) {
            await displayRubygemsPackageData(packageName, targetVersion);
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

        await downloadRubygemsPackages(packageName, versionCount, outputPath, targetVersion);
        return;
    }

    // NPM registry handling (default)
    if (dataMode) {
        await displayPackageData(packageName, targetVersion);
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
    if (targetVersion) {
        log(`Target version: ${targetVersion}`);
    } else {
        log(`Requesting ${versionCount} version(s)`);
    }
    log(`Output directory: ${outputPath}\n`);

    const downloadedVersions = new Set();
    const discoveredVersions = [];
    const allDiscoveredVersions = new Set();

    for (const registry of REGISTRIES) {
        log(`Checking ${registry}...`);

        const isTencent = registry.includes('tencent.com');
        const packageData = await getPackageInfo(registry, packageName, isTencent);

        if (!packageData) {
            continue;
        }

        const result = getLastVersions(packageData, versionCount, targetVersion);

        if (result && result.notFound) {
            for (const v of result.available) allDiscoveredVersions.add(v);
            log(`  Version ${targetVersion} not found in this registry (${result.available.length} other version(s) available)`);
            continue;
        }

        const versions = result;

        if (versions.length === 0) {
            log("  No versions found");
            continue;
        }

        // Track discovered versions for kmsec.uk fallback
        for (const v of versions) {
            if (!discoveredVersions.includes(v.version) && !isSecurityPlaceholderTarball(v.url)) {
                discoveredVersions.push(v.version);
            }
        }

        log(`  Found ${versions.length} version(s):`);
        versions.forEach(v => log(`    - ${v.version}`));

        if (isTencent) {
            log(`  Note: Tencent server may require multiple retry attempts\n`);
        }

        let successCount = 0;
        for (const versionInfo of versions) {
            const { version, url: tarballUrl } = versionInfo;

            if (downloadedVersions.has(version)) {
                log(`  Skipping ${version} (already downloaded)`);
                continue;
            }

            if (isSecurityPlaceholderTarball(tarballUrl)) {
                log(`Skipping security placeholder version: ${version}`);
                continue;
            }

            const success = await downloadPackage(tarballUrl, packageName, version, outputPath, isTencent);
            if (success) {
                successCount++;
                downloadedVersions.add(version);
            }
        }

        if (successCount > 0) {
            log(`\nDownloaded ${successCount} version(s) from ${registry}`);
        } else {
            log(`\nNo new versions downloaded from ${registry}`);
        }

        if (downloadedVersions.size > 0) {
            log(`  ${downloadedVersions.size} unique version(s) downloaded so far\n`);
        }
    }

    if (downloadedVersions.size > 0) {
        log(`\nSuccessfully downloaded ${downloadedVersions.size} unique version(s) across all registries`);
        process.exit(0);
    }

    // Try the npm view CLI method as a fallback
    const npmViewSuccess = await tryNpmViewMethod(packageName, targetVersion ? 1 : versionCount, outputPath, targetVersion);
    if (npmViewSuccess) {
        process.exit(0);
    }

    // Try kmsec.uk DPRK research archive as final fallback
    const kmsecVersionsToTry = targetVersion ? [targetVersion] : discoveredVersions;
    const kmsecSuccess = await tryKmsecMethod(packageName, kmsecVersionsToTry, targetVersion ? 1 : versionCount, outputPath);
    if (kmsecSuccess) {
        process.exit(0);
    }

    if (targetVersion && allDiscoveredVersions.size > 0) {
        const sorted = Array.from(allDiscoveredVersions).sort(compareVersions);
        log(`\nVersion ${targetVersion} not found for ${packageName}.`);
        log(`Available versions discovered: ${sorted.slice(0, 30).join(', ')}${sorted.length > 30 ? ` (+${sorted.length - 30} more)` : ''}`);
        process.exit(1);
    }

    log("\nFailed to download packages from any registry or method");
    process.exit(1);
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
