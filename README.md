![undelete](./images/undelete-banner-logo.png)

# undelete

This package "undeletes" a package that has been deleted from the NPM registry.  How does it do that?
Well, magic of course!  No, no ... on the serious tip, the undelete function works by going to secondary
NPM mirrors and pulling the files from their cache.

## Usage

```bash
undelete <package-name> [options]
```

### Options

- `-n, --number <count>` - Number of versions to download (1-20, default: 5)
- `-p, --path <directory>` - Save packages to specified directory (default: current directory)
- `-s, --silent` - Run in silent mode with no output
- `-h, --help` - Display help message

### Install undelete

```bash
npm undelete
```

### Examples

```bash
undelete express
undelete @angular/core -n 10
undelete lodash --path ./downloads
undelete react -p /tmp/packages -n 15 -s
```

## Features

- Downloads 1-20 most recent versions of any package (default: 5)
- Checks 5 registries in order: npmjs.org, cnpmjs.org, npmmirror.com, huaweicloud.com, tencent.com
- Automatic retry (up to 10 attempts for Tencent mirror)
- Skips security placeholder packages
- Custom output directory support
- Silent mode for automation
- No external dependencies

## Requirements

Node.js 12.0.0 or higher

## Output

Downloaded files are saved as `{package-name}-{version}.tgz` in the specified directory.

## Author

6mile - https://github.com/6mile

## License

MIT
