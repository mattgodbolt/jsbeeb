# Changelog

## [1.7.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.6.0...v1.7.0) (2026-03-16)


### Features

* add FDC, disc drive, and disc snapshot/restore (v2 format) ([#592](https://github.com/mattgodbolt/jsbeeb/issues/592)) ([e7ac8db](https://github.com/mattgodbolt/jsbeeb/commit/e7ac8db0199889c50cc9a30b43948c0c4607700c))
* add rewind scrubber UI with thumbnail filmstrip ([#588](https://github.com/mattgodbolt/jsbeeb/issues/588)) ([78166cc](https://github.com/mattgodbolt/jsbeeb/commit/78166cc7f648b5a04a1a216d2db4fe21e0efc5a7))
* Fix debugInstruction breakpoints and make type() hook-based ([#593](https://github.com/mattgodbolt/jsbeeb/issues/593)) ([00da081](https://github.com/mattgodbolt/jsbeeb/commit/00da081318fef96194373672618c99ef41396861))
* persist dirty disc data and embedded images in snapshots ([#594](https://github.com/mattgodbolt/jsbeeb/issues/594)) ([c4fe340](https://github.com/mattgodbolt/jsbeeb/commit/c4fe34044345f8dae616878ed95e71fc51fe1570))

## [1.6.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.5.0...v1.6.0) (2026-03-16)


### Features

* add persistent breakpoint management to MachineSession ([#589](https://github.com/mattgodbolt/jsbeeb/issues/589)) ([465de85](https://github.com/mattgodbolt/jsbeeb/commit/465de85c2ef51c8448bfae315ce65f371f3be119))

## [1.5.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.4.0...v1.5.0) (2026-03-15)


### Features

* add configurable Tube CPU multiplier setting (issue [#134](https://github.com/mattgodbolt/jsbeeb/issues/134)) ([c19744a](https://github.com/mattgodbolt/jsbeeb/commit/c19744ad5e8037dcb87f1972660d91ad89872b2f))
* add non-cycle-accurate mode for Tube 6502 instruction generation ([#584](https://github.com/mattgodbolt/jsbeeb/issues/584)) ([5455952](https://github.com/mattgodbolt/jsbeeb/commit/5455952557ad7ac7b38248ce5a1227b58234060d))
* add VideoNULA palette support for MODE 7 teletext ([#575](https://github.com/mattgodbolt/jsbeeb/issues/575)) ([049bee8](https://github.com/mattgodbolt/jsbeeb/commit/049bee8a98b708bd2c1f02c485270232e6fd6428))
* add VideoNULA programmable palette support ([#574](https://github.com/mattgodbolt/jsbeeb/issues/574)) ([05d7ca3](https://github.com/mattgodbolt/jsbeeb/commit/05d7ca33458ab81bb23928168167d819c98cb2b7))
* Web Speech API output via RS-423 serial port (*FX3,1) ([#569](https://github.com/mattgodbolt/jsbeeb/issues/569)) ([2f01b04](https://github.com/mattgodbolt/jsbeeb/commit/2f01b041a8147d1138aa3a7e9795cbc72dd28c3c))
* wire up accessibility switch keys for user port, ADC, and fire buttons ([#565](https://github.com/mattgodbolt/jsbeeb/issues/565)) ([faa63b9](https://github.com/mattgodbolt/jsbeeb/commit/faa63b93e520c0e08c7254668e861687996fa962))


### Bug Fixes

* always feed SAA5050 teletext pipeline from video bus ([#578](https://github.com/mattgodbolt/jsbeeb/issues/578)) ([7ff0e12](https://github.com/mattgodbolt/jsbeeb/commit/7ff0e1223b37571c26d07865b7daff0b672e8d1d))
* apply NULA paletteMode in blitter to bypass ULA XOR-7 mapping ([#583](https://github.com/mattgodbolt/jsbeeb/issues/583)) ([49ae587](https://github.com/mattgodbolt/jsbeeb/commit/49ae587eebd0b131f10f3f5106c1b70baf2b741a))
* correct default CMOS FDRIVE step rate for BBC Master ([#581](https://github.com/mattgodbolt/jsbeeb/issues/581)) ([b1f71dc](https://github.com/mattgodbolt/jsbeeb/commit/b1f71dc52f491545c67885b961aa382b9ee7cb7a))
* emulate IC37/IC36 H-blanking feed for SAA5050 pipeline (issue [#546](https://github.com/mattgodbolt/jsbeeb/issues/546)) ([#580](https://github.com/mattgodbolt/jsbeeb/issues/580)) ([7399552](https://github.com/mattgodbolt/jsbeeb/commit/7399552f345e35d7ca4f3276a62dada36cdaed2c))
* focus STH archive filter input when modal opens ([#573](https://github.com/mattgodbolt/jsbeeb/issues/573)) ([b0d5c74](https://github.com/mattgodbolt/jsbeeb/commit/b0d5c743321322fc82ff7b26538f8b492c9b4c86))
* reduce WD1770 head settle time from 30ms to 15ms ([#577](https://github.com/mattgodbolt/jsbeeb/issues/577)) ([7b6a068](https://github.com/mattgodbolt/jsbeeb/commit/7b6a068603d66c2feb373beed8958bb7fd8f3639))
* speak each CR-terminated line immediately, queue without cancel ([#570](https://github.com/mattgodbolt/jsbeeb/issues/570)) ([6c2bd37](https://github.com/mattgodbolt/jsbeeb/commit/6c2bd37b5321c23d48588f4f13937a8338c49af9))

## [1.4.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.3.3...v1.4.0) (2026-02-23)


### Features

* add keyDown, keyUp, and reset methods to MachineSession ([fea06b8](https://github.com/mattgodbolt/jsbeeb/commit/fea06b8f87a0fc8ad822972635d008ae6b329a3b))

## [1.3.3](https://github.com/mattgodbolt/jsbeeb/compare/v1.3.2...v1.3.3) (2026-02-23)


### Bug Fixes

* chdir to public/ so ROM loader finds public/roms/ when installed from npm ([#560](https://github.com/mattgodbolt/jsbeeb/issues/560)) ([593b819](https://github.com/mattgodbolt/jsbeeb/commit/593b81914d8969d9f699812c66fda4c40e5b32b8))

## [1.3.2](https://github.com/mattgodbolt/jsbeeb/compare/v1.3.1...v1.3.2) (2026-02-23)


### Bug Fixes

* use Node 24 in npm-publish job — npm v10 (Node 22) doesn't support OIDC trusted publishing ([#557](https://github.com/mattgodbolt/jsbeeb/issues/557)) ([f8ff684](https://github.com/mattgodbolt/jsbeeb/commit/f8ff6841afa30c88dd502bb8acd297db1ef299c9))

## [1.3.1](https://github.com/mattgodbolt/jsbeeb/compare/v1.3.0...v1.3.1) (2026-02-23)


### Bug Fixes

* decrement SP by 3 during reset sequence ([#547](https://github.com/mattgodbolt/jsbeeb/issues/547)) ([#549](https://github.com/mattgodbolt/jsbeeb/issues/549)) ([a08f9ff](https://github.com/mattgodbolt/jsbeeb/commit/a08f9ff9c0513d84792138b1a2c6e5d01912de07))

## [1.3.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.2.0...v1.3.0) (2025-12-01)


### Features

* Add settings persistence for Electron app ([#543](https://github.com/mattgodbolt/jsbeeb/issues/543)) ([ec153a0](https://github.com/mattgodbolt/jsbeeb/commit/ec153a062dd3f3e628fd69bea8c510d3c95e0055))

## [1.2.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.1.1...v1.2.0) (2025-12-01)


### Features

* Add native menu support for web modals in Electron app ([#542](https://github.com/mattgodbolt/jsbeeb/issues/542)) ([8cdc6d0](https://github.com/mattgodbolt/jsbeeb/commit/8cdc6d0c791de2b1b0d4997b581f5c7bc6877b7b))
* Optimised polltime routine ([#540](https://github.com/mattgodbolt/jsbeeb/issues/540)) ([72ca9f5](https://github.com/mattgodbolt/jsbeeb/commit/72ca9f50bd5e2346e8ecb04219b33f2a9af2832b))

## [1.1.1](https://github.com/mattgodbolt/jsbeeb/compare/v1.1.0...v1.1.1) (2025-11-21)


### Bug Fixes

* Fix Windows Build support ([8ffa1a0](https://github.com/mattgodbolt/jsbeeb/commit/8ffa1a037fdfd7e38e072dca65da5b1959823fb2))

## [1.1.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.0.1...v1.1.0) (2025-11-21)


### Features

* Windows Electron build support ([1955a5f](https://github.com/mattgodbolt/jsbeeb/commit/1955a5f3ad7e9eb12cdff2e9860d8b0e304196ee))

## [1.0.1](https://github.com/mattgodbolt/jsbeeb/compare/v1.0.0...v1.0.1) (2025-11-20)


### Bug Fixes

* Trying to get release-please to work

## 1.0.0 (2025-11-20)

First actual release with a changelog! These fixes below are not the only thing in this release, we previously had v0.0.7 which was 4+ years old. But - this include Electron support again!

### Bug Fixes

- add application icon for Electron ([#536](https://github.com/mattgodbolt/jsbeeb/issues/536)) ([64c8043](https://github.com/mattgodbolt/jsbeeb/commit/64c80438bf7c0f87db993b9a878665e3d3b090bc))
- enable window scaling in Electron and modernize event handlers ([#533](https://github.com/mattgodbolt/jsbeeb/issues/533)) ([64551c9](https://github.com/mattgodbolt/jsbeeb/commit/64551c9d53c3a1a253dd1ac8f6b0f9dd9f266272))
- remove invalid package-name parameter from release-please action ([#535](https://github.com/mattgodbolt/jsbeeb/issues/535)) ([5dd0436](https://github.com/mattgodbolt/jsbeeb/commit/5dd043601282e1aae976a8cd58c2071bd2b15954))
