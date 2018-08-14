# Change Log

## [5.0.0]
### Added
- Exchange class for simplified thread communication.


## [4.0.0]
### Changed
- Added Postgres as a supported backing store 
  (doing so required adding an async `initialize()` to the storage interface 
  and making the interface's `shutdown()` routine async). 
- Note: **THIS IS A BREAKING CHANGE** because `storage.initialize()` now
  needs to be called to ensure your backing store is up and running
  (well, if your code needs to work properly across all possible backing stores).


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
[5.0.0]: https://github.com/ForstaLabs/librelay-node/tree/v5.0.0
[4.0.0]: https://github.com/ForstaLabs/librelay-node/tree/v4.0.0
[3.4.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.4.0
[3.3.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.3.0
[3.2.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.2.0
[3.1.0]: https://github.com/ForstaLabs/librelay-node/tree/v3.1.0
