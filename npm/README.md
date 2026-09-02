![undelete](./images/undelete-banner-logo.png)

# undelete

```
                   __     __     __     
  __  ______  ____/ /__  / /__  / /____ 
 / / / / __ \/ __  / _ \/ / _ \/ __/ _ \
/ /_/ / / / / /_/ /  __/ /  __/ /_/  __/
\__,_/_/ /_/\__,_/\___/_/\___/\__/\___/
```

This package "undeletes" a package that has been deleted from the NPM registry.  How does it do that?
Well, magic of course!  No, no ... on the serious tip, the undelete function works by checking secondary
NPM mirrors and pulling the files from their cache. This package will also undelete the package metadata
which will tell you the NPM user, email and other metadata that's helpful for research purposes.

## Overview

When packages are removed from NPM, PyPI, or RubyGems (often due to malware detection), they become unavailable through normal channels. This tool recovers those packages by:

- **NPM**: Querying Chinese mirror servers (cnpmjs, npmmirror, Huawei, Tencent) that may still have cached copies
- **PyPI**: Using [ecosyste.ms](https://ecosyste.ms) which indexes `files.pythonhosted.org` URLs that often remain accessible. For deleted packages not in ecosyste.ms, a **BigQuery fallback** queries the PyPI public dataset to recover download URLs.
- **RubyGems**: Discovering versions via [ecosyste.ms](https://ecosyste.ms), then trying rubygems.org directly (works for non-yanked gems), then Chinese full mirrors (TUNA, USTC, BFSU, Aliyun, Huawei, Ruby China) which often retain yanked gems until their next sync.
- **socket.dev fallback** (`--socket`, npm and rubygems): Pulls source files directly from socket.dev's file browser using a headless Chrome. For npm the files are repackaged into a valid `.tgz`; for rubygems they land as a source `.tar.gz` (not an installable `.gem`).

This is particularly useful for security researchers analyzing malicious packages that have been taken down.

## How to install

```bash
npm install undelete
```

## Usage

```bash
undelete <registry> <package-name> [options]
```

Requires Node.js 14+.

## Usage

```bash
undelete <registry> <package-name> [options]
```

### Registries

| Registry | Description |
|----------|-------------|
| `npm` | NPM (npmjs.org) packages |
| `pypi` | PyPI (pypi.org) Python packages |
| `rubygems` (or `gem`) | RubyGems (rubygems.org) Ruby packages |

### Options

| Option | Description |
|--------|-------------|
| `-n, --number <count>` | Number of versions to download (1-20, default: 5) |
| `-t, --target-version <ver>` | Look up exactly this version (overrides `-n`). Errors and lists available versions if not found. |
| `-p, --path <directory>` | Save downloaded packages to specified directory (default: current directory) |
| `-d, --data` | Get package metadata instead of downloading files |
| `-s, --silent` | Silent mode - outputs JSON for `--data`, suppresses logs otherwise |
| `--gcp-credentials <file>` | Path to GCP service account JSON for PyPI BigQuery fallback |
| `--socket` | Pull files from socket.dev (npm and rubygems). Skips other sources. Requires puppeteer + Chrome. |
| `-h, --help` | Display help message |
| `-v, --version` | Show version |

You can also set `GCP_CREDENTIALS` environment variable instead of using `--gcp-credentials`.

## Examples

### Downloading Packages

```bash
# Download latest 5 versions of an NPM package
undelete npm express

# Download specific number of versions
undelete npm @angular/core -n 10

# Download to a specific directory
undelete npm lodash --path ./downloads

# Download PyPI package
undelete pypi requests

# Download PyPI package with options
undelete pypi flask -n 3 -p ./malware_samples

# Download deleted PyPI package using BigQuery fallback
undelete pypi tabletas --gcp-credentials ./service-account.json

# Download a specific compromised version
undelete pypi elementary-data --target-version 0.23.3
undelete npm chalk -t 5.3.0

# RubyGems: recover latest and specific versions
undelete rubygems rails
undelete gem sinatra -n 3 -p ./gems
undelete rubygems some-gem --target-version 1.2.3

# RubyGems: recover yanked gem via socket.dev (writes <name>-<version>-source.tar.gz)
undelete rubygems some-yanked-gem --socket
```

### Getting Package Metadata

The `--data` flag retrieves package metadata including maintainer information, which is useful for investigating removed malicious packages.

```bash
# Human-readable output
undelete npm express --data

# JSON output (for scripting)
undelete npm mayhem-wma --data --silent

# PyPI metadata
undelete pypi some-package --data -s

# RubyGems metadata
undelete rubygems rails --data
undelete gem sinatra --data --silent
```

### Example JSON Output

```json
{
  "package": "mayhem-wma",
  "version": "1.0.1",
  "description": "Mayhem WMA - A professional utility package...",
  "npmUser": "petternilssonorg",
  "npmUserEmail": "piter.jb0817@gmail.com",
  "maintainers": [
    {
      "name": "petternilssonorg",
      "email": "piter.jb0817@gmail.com"
    }
  ],
  "repository": "https://github.com/kinexbt/mayhem-wma",
  "license": "MIT",
  "downloads": null,
  "dependentPackages": 0,
  "dependentRepos": 0,
  "firstPublished": "2025-11-20T00:05:31.566Z",
  "lastPublished": "2025-11-20T00:05:31.566Z",
  "isSecurityPlaceholder": true
}
```

## BigQuery Fallback for PyPI

PyPI never actually deletes files from object storage (`files.pythonhosted.org`). The BigQuery public dataset `bigquery-public-data.pypi.distribution_metadata` retains metadata for all packages, including deleted ones. This tool can query BigQuery to recover download URLs when ecosyste.ms doesn't have the package.

### Setup

1. Create a Google Cloud project (free tier available)
2. Enable the BigQuery API
3. Create a service account with BigQuery Job User role
4. Download the service account JSON key file
5. Pass via `--gcp-credentials` or set `GCP_CREDENTIALS` environment variable

```bash
# Create service account (one-time setup)
gcloud iam service-accounts create bigquery-reader \
  --display-name="BigQuery Reader"

# Grant BigQuery access
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:bigquery-reader@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="roles/bigquery.jobUser"

# Download key
gcloud iam service-accounts keys create ~/bigquery-credentials.json \
  --iam-account=bigquery-reader@YOUR_PROJECT.iam.gserviceaccount.com

# Use with undelete
export GCP_CREDENTIALS=~/bigquery-credentials.json
undelete pypi deleted-package
```

## License

MIT

## Author

Created by [6mile](https://github.com/6mile)

## Contributing

Issues and pull requests welcome at [github.com/6mile/undelete](https://github.com/6mile/undelete)
