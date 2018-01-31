# Change Log

## [3.5.0]
### Changed
- Added Postgres as a possible backing store (required adding an async initialize to the storage interface and making the shutdown routine async). 
- Note: **THIS IS A BREAKING CHANGE** because `storage.initialize()` needs to be called to ensure your backing store is up and running (if your code needs to be portable across all backing stores).


## [3.4.0]
### Changed
- AtlasClient.authenticate[...] classmethods now return an instance.


## [3.3.0]
### Added
- AtlasClient.resolveTagsBulk([...]) method for doing multple tag resolutions
  in one call.


## [3.2.0]
### Changed
- Refactored atlas authentication


## [3.1.0]
### Added
- Changelog file


[unreleased]: https://github.com/ForstaLabs/librelay-node/tree/master
[3.4.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.4.0
[3.3.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.3.0
[3.2.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.2.0
[3.1.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.1.0
