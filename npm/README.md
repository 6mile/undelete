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

When packages are removed from NPM or PyPI (often due to malware detection), they become unavailable through normal channels. This tool recovers those packages by:

- **NPM**: Querying Chinese mirror servers (cnpmjs, npmmirror, Huawei, Tencent) that may still have cached copies
- **PyPI**: Using [ecosyste.ms](https://ecosyste.ms) which indexes `files.pythonhosted.org` URLs that often remain accessible

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

### Options

| Option | Description |
|--------|-------------|
| `-n, --number <count>` | Number of versions to download (1-20, default: 5) |
| `-p, --path <directory>` | Save downloaded packages to specified directory (default: current directory) |
| `-d, --data` | Get package metadata instead of downloading files |
| `-s, --silent` | Silent mode - outputs JSON for `--data`, suppresses logs otherwise |
| `-h, --help` | Display help message |
| `-v, --version` | Show version |

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

## License

MIT

## Author

Created by [6mile](https://github.com/6mile)

## Contributing

Issues and pull requests welcome at [github.com/6mile/undelete](https://github.com/6mile/undelete)
