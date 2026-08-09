# Changelog

## [1.17.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.16.0...v1.17.0) (2026-08-09)


### Features

* add a toast, for saying something that needs nothing doing about it ([#796](https://github.com/mattgodbolt/jsbeeb/issues/796)) ([06cdabf](https://github.com/mattgodbolt/jsbeeb/commit/06cdabf800af4c08ca8a3ea41461fb94d635e9fa))
* browse the HFE disc archive from within jsbeeb ([#800](https://github.com/mattgodbolt/jsbeeb/issues/800)) ([4f8458c](https://github.com/mattgodbolt/jsbeeb/commit/4f8458cd4082bdc41042ad5fab2ef73caefbe69a))
* let a drive be set to 40 or 80 tracks ([#792](https://github.com/mattgodbolt/jsbeeb/issues/792)) ([3f96acc](https://github.com/mattgodbolt/jsbeeb/commit/3f96acc260694a42e25c339ff7a5133119b45c4e))


### Bug Fixes

* keep the unzipped name when loading from the STH archive ([#806](https://github.com/mattgodbolt/jsbeeb/issues/806)) ([3b914cc](https://github.com/mattgodbolt/jsbeeb/commit/3b914cc190c450ececc71355fd362f57eb989e4b))
* let sniff-disc-layout take the directory where its usage says ([#804](https://github.com/mattgodbolt/jsbeeb/issues/804)) ([e805568](https://github.com/mattgodbolt/jsbeeb/commit/e805568b5b96ff08256a55cb6efadb17c2abc0ba))
* read a 40 track disc that a flux image holds as an 80 track drive saw it ([#799](https://github.com/mattgodbolt/jsbeeb/issues/799)) ([bc88a46](https://github.com/mattgodbolt/jsbeeb/commit/bc88a46c3afa75db58beb6856974da46c4300c57))
* read a 40 track disc the way a 40 track drive wrote it ([#791](https://github.com/mattgodbolt/jsbeeb/issues/791)) ([e2a5e6a](https://github.com/mattgodbolt/jsbeeb/commit/e2a5e6a7a6dd56a9807d5fedecbee0b43ab48a3c))
* survive a bad start (bad image, bad model, unseen audio warning) ([#808](https://github.com/mattgodbolt/jsbeeb/issues/808)) ([9d876e6](https://github.com/mattgodbolt/jsbeeb/commit/9d876e60a5520d5f52ff92c7ecb1e134d51a2ad2))
* take an HFE out of a zip ([#809](https://github.com/mattgodbolt/jsbeeb/issues/809)) ([e43975e](https://github.com/mattgodbolt/jsbeeb/commit/e43975ec71918a800fd30f501498998300050547))
* toast the notices that were using the error dialog ([#807](https://github.com/mattgodbolt/jsbeeb/issues/807)) ([68c3b68](https://github.com/mattgodbolt/jsbeeb/commit/68c3b688390fa1070ccf8aae35542242325f8879))
* unzip an ADFS disc image ([#802](https://github.com/mattgodbolt/jsbeeb/issues/802)) ([8f11bd4](https://github.com/mattgodbolt/jsbeeb/commit/8f11bd4c3a6047ddcf9d7a7fc513020437042f2a))

## [1.16.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.15.0...v1.16.0) (2026-08-08)


### Features

* add a disc surface visualiser ([#774](https://github.com/mattgodbolt/jsbeeb/issues/774)) ([5e3a7b2](https://github.com/mattgodbolt/jsbeeb/commit/5e3a7b27e80f78481a836778dd1cc3bd08cc4c50))
* add an xBR display mode that smooths the picture ([#762](https://github.com/mattgodbolt/jsbeeb/issues/762)) ([30fdd39](https://github.com/mattgodbolt/jsbeeb/commit/30fdd39b1f4509ac73886415fd8dadfe84979806))
* load STH discs and tapes from the bbc.xania.org mirror ([#689](https://github.com/mattgodbolt/jsbeeb/issues/689)) ([614b57d](https://github.com/mattgodbolt/jsbeeb/commit/614b57d4c0fb75594f6e4d5482b7b36d3e602a28))
* mirror Stairway to Hell archive into S3 ([#688](https://github.com/mattgodbolt/jsbeeb/issues/688)) ([ef32159](https://github.com/mattgodbolt/jsbeeb/commit/ef3215944b4fca7ca00ed878ffa992fc7e596df8))


### Bug Fixes

* count the Atom's cycleSeconds in real seconds ([#755](https://github.com/mattgodbolt/jsbeeb/issues/755)) ([9814a65](https://github.com/mattgodbolt/jsbeeb/commit/9814a65473f21d97dccb71bed20f8cb54b7a236c)), closes [#751](https://github.com/mattgodbolt/jsbeeb/issues/751)
* give the external second processor its real CMOS instruction set ([#752](https://github.com/mattgodbolt/jsbeeb/issues/752)) ([36f28e0](https://github.com/mattgodbolt/jsbeeb/commit/36f28e0547c2c21333263b7e9fd77e71e12a6814)), closes [#746](https://github.com/mattgodbolt/jsbeeb/issues/746)
* handle every 1770 force interrupt condition instead of throwing ([#763](https://github.com/mattgodbolt/jsbeeb/issues/763)) ([5574446](https://github.com/mattgodbolt/jsbeeb/commit/55744461ca9fb3012e5c0c39f59771edc613f864)), closes [#761](https://github.com/mattgodbolt/jsbeeb/issues/761)
* keep the display working when a filter will not build ([#780](https://github.com/mattgodbolt/jsbeeb/issues/780)) ([3c7645e](https://github.com/mattgodbolt/jsbeeb/commit/3c7645e8f4da31f08c89b9fe5606dc040cf645b5))
* keep the touchscreen polling instead of crashing the emulator ([#759](https://github.com/mattgodbolt/jsbeeb/issues/759)) ([b7b2daa](https://github.com/mattgodbolt/jsbeeb/commit/b7b2daa0ec760b7ab74a1cd9c820a263a583705b)), closes [#758](https://github.com/mattgodbolt/jsbeeb/issues/758)
* keep writing back a disc image with a damaged sector ([#789](https://github.com/mattgodbolt/jsbeeb/issues/789)) ([0ec24c8](https://github.com/mattgodbolt/jsbeeb/commit/0ec24c88bd2591c9114f88c25f84e4e73d9f4ccb))
* latch the Tube ULA's NMI request to the parasite ([#754](https://github.com/mattgodbolt/jsbeeb/issues/754)) ([e05c742](https://github.com/mattgodbolt/jsbeeb/commit/e05c74240ad846ef4ff722c2dd8ac93436b92b03))
* record tracks written to a disc with no write-track callback ([#777](https://github.com/mattgodbolt/jsbeeb/issues/777)) ([323b723](https://github.com/mattgodbolt/jsbeeb/commit/323b723328e1c178c3b565e50b11840b021453ea))
* release GL objects when the display mode changes ([#764](https://github.com/mattgodbolt/jsbeeb/issues/764)) ([873ee29](https://github.com/mattgodbolt/jsbeeb/commit/873ee29f6fedf49b4cdea7000c4fd632a0010f86))
* repaint displays that run with the CRTC's R4 at zero ([#767](https://github.com/mattgodbolt/jsbeeb/issues/767)) ([c115932](https://github.com/mattgodbolt/jsbeeb/commit/c115932b6071232d6a5b13ccf7e0621941559905))
* stop the disc panel's readout reflowing as it updates ([#788](https://github.com/mattgodbolt/jsbeeb/issues/788)) ([d378a24](https://github.com/mattgodbolt/jsbeeb/commit/d378a248be3ee77bd815f35aee68579c2864fbc3))


### Performance Improvements

* decode flux marks with 32 bit words instead of BigInts ([#753](https://github.com/mattgodbolt/jsbeeb/issues/753)) ([c87c134](https://github.com/mattgodbolt/jsbeeb/commit/c87c134fe6d80539004161e2fb290aa1e1ba37de)), closes [#749](https://github.com/mattgodbolt/jsbeeb/issues/749)

## [1.15.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.14.0...v1.15.0) (2026-08-02)


### Features

* document key remapping, and report mappings that can't be applied ([#750](https://github.com/mattgodbolt/jsbeeb/issues/750)) ([3495a77](https://github.com/mattgodbolt/jsbeeb/commit/3495a77b6f4ef4984b6a5f8092707e0b2d9d46a8))
* fit each machine the second processor it was sold with ([5b045c5](https://github.com/mattgodbolt/jsbeeb/commit/5b045c54cbc9995545acf967f6d3775f3eab3232))


### Bug Fixes

* clock the second processor at its own 3MHz ([#732](https://github.com/mattgodbolt/jsbeeb/issues/732)) ([aeadc31](https://github.com/mattgodbolt/jsbeeb/commit/aeadc31affe136332b239ebb08fe8fe289481a71)), closes [#703](https://github.com/mattgodbolt/jsbeeb/issues/703)
* discard stale teletext channel fetches ([#734](https://github.com/mattgodbolt/jsbeeb/issues/734)) ([30229c5](https://github.com/mattgodbolt/jsbeeb/commit/30229c564a7c1f51a1225a59910049ec7b051fa1))
* let Safari finish blob downloads before the URL is revoked ([#741](https://github.com/mattgodbolt/jsbeeb/issues/741)) ([b7501b4](https://github.com/mattgodbolt/jsbeeb/commit/b7501b4b7b23f534aedf7e3caafc151b8ccbffa7)), closes [#494](https://github.com/mattgodbolt/jsbeeb/issues/494)
* model serial transmit timing ([#738](https://github.com/mattgodbolt/jsbeeb/issues/738)) ([00336ff](https://github.com/mattgodbolt/jsbeeb/commit/00336ff14a189eee11e1815076dee6890ec490c9)), closes [#66](https://github.com/mattgodbolt/jsbeeb/issues/66)
* refuse to save a disc an SSD or DSD cannot hold ([#740](https://github.com/mattgodbolt/jsbeeb/issues/740)) ([adc55c8](https://github.com/mattgodbolt/jsbeeb/commit/adc55c87cf8c208037ed9bbba985fe238a4efa16))
* report teletext channel load failures to the user ([#742](https://github.com/mattgodbolt/jsbeeb/issues/742)) ([b6411eb](https://github.com/mattgodbolt/jsbeeb/commit/b6411eb6aa8a5bf3089b1fdf3dac2b0aead41408))


### Performance Improvements

* skip the shortfall scan when forcing an SSD or DSD save ([#744](https://github.com/mattgodbolt/jsbeeb/issues/744)) ([6aad144](https://github.com/mattgodbolt/jsbeeb/commit/6aad14458240cdfcdebd21047051b1abfb9b2e17))

## [1.14.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.13.1...v1.14.0) (2026-07-30)


### Features

* allow MachineSession to attach a Tube 65C02 co-processor ([#706](https://github.com/mattgodbolt/jsbeeb/issues/706)) ([2999610](https://github.com/mattgodbolt/jsbeeb/commit/299961068fb0a91bd726dfe87ad215dd92e3d6db))
* save and restore second processor state ([#719](https://github.com/mattgodbolt/jsbeeb/issues/719)) ([c346d77](https://github.com/mattgodbolt/jsbeeb/commit/c346d779e1e09b2c6c955846a45997dad19cc47c))


### Bug Fixes

* defer the restart instead of discarding the change ([#721](https://github.com/mattgodbolt/jsbeeb/issues/721)) ([9123a0e](https://github.com/mattgodbolt/jsbeeb/commit/9123a0eb0a2cbf4505b23bef4a621d1f5a53ad18)), closes [#717](https://github.com/mattgodbolt/jsbeeb/issues/717)
* let the configuration dialog scroll on short screens ([#726](https://github.com/mattgodbolt/jsbeeb/issues/726)) ([c8ae1d4](https://github.com/mattgodbolt/jsbeeb/commit/c8ae1d451ca4fb907910caaf804c8fe179f80afd))
* make ?cpuMultiplier= run the CPU faster than the peripherals again ([#725](https://github.com/mattgodbolt/jsbeeb/issues/725)) ([4c57345](https://github.com/mattgodbolt/jsbeeb/commit/4c57345fbcdcace4f56f68a7c11c401ccd7b39ff))
* poll the teletext adaptor so it receives broadcast data ([#720](https://github.com/mattgodbolt/jsbeeb/issues/720)) ([07265e0](https://github.com/mattgodbolt/jsbeeb/commit/07265e082f0759a2b904fe6f0669301f4cfeb6f0))
* use clientX/Y for mouse coordinates ([#696](https://github.com/mattgodbolt/jsbeeb/issues/696)) ([8e87f9f](https://github.com/mattgodbolt/jsbeeb/commit/8e87f9ffbd8f1cfe9823639eb3430755cac9e18b))
* work around Chrome 150 V8 bug that wedged the emulator after ~1 minute ([#704](https://github.com/mattgodbolt/jsbeeb/issues/704)) ([efc42cb](https://github.com/mattgodbolt/jsbeeb/commit/efc42cb730a8bbcf5e1f9e7cbfe28e2f7143e317))
* write two-byte Tube R3 transfers into the right FIFO ([#718](https://github.com/mattgodbolt/jsbeeb/issues/718)) ([256d08f](https://github.com/mattgodbolt/jsbeeb/commit/256d08f8c83a6210098e86bf1a550847b3d8053b))

## [1.13.1](https://github.com/mattgodbolt/jsbeeb/compare/v1.13.0...v1.13.1) (2026-05-11)


### Bug Fixes

* use process.defaultApp to detect packaged Electron app ([#692](https://github.com/mattgodbolt/jsbeeb/issues/692)) ([653a5f2](https://github.com/mattgodbolt/jsbeeb/commit/653a5f2c4a0c4b32dfcaf44f581520b43d117035))

## [1.13.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.12.0...v1.13.0) (2026-04-23)


### Features

* add Acorn Atom model definitions and ROM assets ([#635](https://github.com/mattgodbolt/jsbeeb/issues/635)) ([388ca1a](https://github.com/mattgodbolt/jsbeeb/commit/388ca1aead8a54312424332919092578dd52940b))
* add Atom 1-bit speaker channel to SoundChip ([#647](https://github.com/mattgodbolt/jsbeeb/issues/647)) ([0bd8f11](https://github.com/mattgodbolt/jsbeeb/commit/0bd8f1153a568699d5078aa1605fd704a1958cb0))
* add Atom hostname detection and MMC URL parameter ([#650](https://github.com/mattgodbolt/jsbeeb/issues/650)) ([4c6be7a](https://github.com/mattgodbolt/jsbeeb/commit/4c6be7a80526bbf67866a36d8220e4717b6a7033))
* add Atom keyboard mapping utilities ([#637](https://github.com/mattgodbolt/jsbeeb/issues/637)) ([a49afde](https://github.com/mattgodbolt/jsbeeb/commit/a49afdeabf334bc2afaceeff189ba601012131ad))
* add Atom MMC/SD card interface ([#644](https://github.com/mattgodbolt/jsbeeb/issues/644)) ([6ec0361](https://github.com/mattgodbolt/jsbeeb/commit/6ec036126031e105a04b565bdee296493b23c0f4))
* add Atom PPIA (8255 Peripheral Interface Adapter) ([#648](https://github.com/mattgodbolt/jsbeeb/issues/648)) ([1584bd3](https://github.com/mattgodbolt/jsbeeb/commit/1584bd3508dd7662e44c7ed08ed6d2990bb2e92c))
* add Atom snapshot/restore support ([#653](https://github.com/mattgodbolt/jsbeeb/issues/653)) ([0708415](https://github.com/mattgodbolt/jsbeeb/commit/07084157fb1356f20ee9ccd14c8699172b927365))
* add Atom support to MachineSession and emulator skill ([#677](https://github.com/mattgodbolt/jsbeeb/issues/677)) ([0c1de51](https://github.com/mattgodbolt/jsbeeb/commit/0c1de51b9e1ae232ef7669f50436b53968a82b74))
* add AtomCpu6502 subclass for Atom memory map and devices ([#652](https://github.com/mattgodbolt/jsbeeb/issues/652)) ([a0bd4bc](https://github.com/mattgodbolt/jsbeeb/commit/a0bd4bcd0ada3614de40b56aea4b660729cc9e05))
* add cassette play/stop control for Atom tape models ([#675](https://github.com/mattgodbolt/jsbeeb/issues/675)) ([efe0bdd](https://github.com/mattgodbolt/jsbeeb/commit/efe0bdddc8e4b2541d5cf6e80bacd389a17907de))
* add keyboard adapter pattern for BBC/Atom routing ([#651](https://github.com/mattgodbolt/jsbeeb/issues/651)) ([3857d9e](https://github.com/mattgodbolt/jsbeeb/commit/3857d9e54de0d461f857a740b25ba81dfeb2d1f8))
* add MC6847 video chip emulation for Acorn Atom ([#636](https://github.com/mattgodbolt/jsbeeb/issues/636)) ([a9b71b3](https://github.com/mattgodbolt/jsbeeb/commit/a9b71b36c05361fd6ee1fb2b8e0f35793ad1d957))
* extend tape handling for Acorn Atom format ([#649](https://github.com/mattgodbolt/jsbeeb/issues/649)) ([91cd39e](https://github.com/mattgodbolt/jsbeeb/commit/91cd39e12d5eb1cb41d55ae864076d2a97b8b5c5))
* remove VITE_ATOM_ENABLED gate ([#662](https://github.com/mattgodbolt/jsbeeb/issues/662)) ([21eada6](https://github.com/mattgodbolt/jsbeeb/commit/21eada6fcf885218fefcfacae8238e9e56631851))
* wire Atom support into main.js ([#660](https://github.com/mattgodbolt/jsbeeb/issues/660)) ([df1381c](https://github.com/mattgodbolt/jsbeeb/commit/df1381c963dd7adcd203b227b0dd5da90d0218ac))


### Bug Fixes

* add DC-blocking filter to Atom speaker output ([#666](https://github.com/mattgodbolt/jsbeeb/issues/666)) ([8efe781](https://github.com/mattgodbolt/jsbeeb/commit/8efe78151c608f070709164513265ac0a101e231))
* add debounce gap between paste key releases on Atom ([#679](https://github.com/mattgodbolt/jsbeeb/issues/679)) ([dae097a](https://github.com/mattgodbolt/jsbeeb/commit/dae097a3e9a88a2d16da7499cc6fb9480849df46))
* Atom tests, PPIA mirroring, and speaker timing ([#680](https://github.com/mattgodbolt/jsbeeb/issues/680)) ([3276adf](https://github.com/mattgodbolt/jsbeeb/commit/3276adf1f34db2fe2c4efc42da88c82fd0be1058))
* correct paste timing and SHIFT key for Atom ([#663](https://github.com/mattgodbolt/jsbeeb/issues/663)) ([bcb1a10](https://github.com/mattgodbolt/jsbeeb/commit/bcb1a10128e7f56bbb0ac60c7ae524d3181701fa))
* speakerChannel epoch wrong when advance() splits into chunks ([#682](https://github.com/mattgodbolt/jsbeeb/issues/682)) ([a004d99](https://github.com/mattgodbolt/jsbeeb/commit/a004d99d6a2dcd3989285e2869f6aa034a08ea3f))
* use phase-continuous wavebits for Atom tape loading ([#678](https://github.com/mattgodbolt/jsbeeb/issues/678)) ([d27b642](https://github.com/mattgodbolt/jsbeeb/commit/d27b6428f7c5e06a983bd1d5119c68fed7524e0e))

## [1.12.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.11.0...v1.12.0) (2026-04-04)


### Features

* load BeebEm UEF save state files ([#622](https://github.com/mattgodbolt/jsbeeb/issues/622)) ([92cb949](https://github.com/mattgodbolt/jsbeeb/commit/92cb9498fd0b6d63bee231b4b3d0c2223f37717d))


### Bug Fixes

* document intentional empty catch in decompress() ([#639](https://github.com/mattgodbolt/jsbeeb/issues/639)) ([2e5538f](https://github.com/mattgodbolt/jsbeeb/commit/2e5538f99c511c79b13c732b80d15ca52ead6faa))

## [1.11.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.10.1...v1.11.0) (2026-04-04)


### Features

* add configurable Tube CPU multiplier setting (issue [#134](https://github.com/mattgodbolt/jsbeeb/issues/134)) ([c19744a](https://github.com/mattgodbolt/jsbeeb/commit/c19744ad5e8037dcb87f1972660d91ad89872b2f))
* add FDC, disc drive, and disc snapshot/restore (v2 format) ([#592](https://github.com/mattgodbolt/jsbeeb/issues/592)) ([e7ac8db](https://github.com/mattgodbolt/jsbeeb/commit/e7ac8db0199889c50cc9a30b43948c0c4607700c))
* add keyDown, keyUp, and reset methods to MachineSession ([fea06b8](https://github.com/mattgodbolt/jsbeeb/commit/fea06b8f87a0fc8ad822972635d008ae6b329a3b))
* Add native menu support for web modals in Electron app ([#542](https://github.com/mattgodbolt/jsbeeb/issues/542)) ([8cdc6d0](https://github.com/mattgodbolt/jsbeeb/commit/8cdc6d0c791de2b1b0d4997b581f5c7bc6877b7b))
* add non-cycle-accurate mode for Tube 6502 instruction generation ([#584](https://github.com/mattgodbolt/jsbeeb/issues/584)) ([5455952](https://github.com/mattgodbolt/jsbeeb/commit/5455952557ad7ac7b38248ce5a1227b58234060d))
* add persistent breakpoint management to MachineSession ([#589](https://github.com/mattgodbolt/jsbeeb/issues/589)) ([465de85](https://github.com/mattgodbolt/jsbeeb/commit/465de85c2ef51c8448bfae315ce65f371f3be119))
* add rewind scrubber UI with thumbnail filmstrip ([#588](https://github.com/mattgodbolt/jsbeeb/issues/588)) ([78166cc](https://github.com/mattgodbolt/jsbeeb/commit/78166cc7f648b5a04a1a216d2db4fe21e0efc5a7))
* Add settings persistence for Electron app ([#543](https://github.com/mattgodbolt/jsbeeb/issues/543)) ([ec153a0](https://github.com/mattgodbolt/jsbeeb/commit/ec153a062dd3f3e628fd69bea8c510d3c95e0055))
* add VideoNULA palette support for MODE 7 teletext ([#575](https://github.com/mattgodbolt/jsbeeb/issues/575)) ([049bee8](https://github.com/mattgodbolt/jsbeeb/commit/049bee8a98b708bd2c1f02c485270232e6fd6428))
* add VideoNULA programmable palette support ([#574](https://github.com/mattgodbolt/jsbeeb/issues/574)) ([05d7ca3](https://github.com/mattgodbolt/jsbeeb/commit/05d7ca33458ab81bb23928168167d819c98cb2b7))
* cassette motor relay click sound with audio refactor ([#582](https://github.com/mattgodbolt/jsbeeb/issues/582)) ([05906c3](https://github.com/mattgodbolt/jsbeeb/commit/05906c380153e278e542da7336dfbac652a17710))
* Fix debugInstruction breakpoints and make type() hook-based ([#593](https://github.com/mattgodbolt/jsbeeb/issues/593)) ([00da081](https://github.com/mattgodbolt/jsbeeb/commit/00da081318fef96194373672618c99ef41396861))
* Optimised polltime routine ([#540](https://github.com/mattgodbolt/jsbeeb/issues/540)) ([72ca9f5](https://github.com/mattgodbolt/jsbeeb/commit/72ca9f50bd5e2346e8ecb04219b33f2a9af2832b))
* persist dirty disc data and embedded images in snapshots ([#594](https://github.com/mattgodbolt/jsbeeb/issues/594)) ([c4fe340](https://github.com/mattgodbolt/jsbeeb/commit/c4fe34044345f8dae616878ed95e71fc51fe1570))
* snapshot SWRAM, add capture API to TestMachine ([#606](https://github.com/mattgodbolt/jsbeeb/issues/606)) ([08c20de](https://github.com/mattgodbolt/jsbeeb/commit/08c20dece7ee19a1807aa4cc637031dda2b53bbe))
* TestMachine case handling, keyDown/keyUp, loadSidewaysRam ([#598](https://github.com/mattgodbolt/jsbeeb/issues/598)) ([ba6b656](https://github.com/mattgodbolt/jsbeeb/commit/ba6b6569921363cb59a5dfc143aa170cee2c08dd))
* Web Speech API output via RS-423 serial port (*FX3,1) ([#569](https://github.com/mattgodbolt/jsbeeb/issues/569)) ([2f01b04](https://github.com/mattgodbolt/jsbeeb/commit/2f01b041a8147d1138aa3a7e9795cbc72dd28c3c))
* Windows Electron build support ([1955a5f](https://github.com/mattgodbolt/jsbeeb/commit/1955a5f3ad7e9eb12cdff2e9860d8b0e304196ee))
* wire up accessibility switch keys for user port, ADC, and fire buttons ([#565](https://github.com/mattgodbolt/jsbeeb/issues/565)) ([faa63b9](https://github.com/mattgodbolt/jsbeeb/commit/faa63b93e520c0e08c7254668e861687996fa962))


### Bug Fixes

* add application icon for Electron ([#536](https://github.com/mattgodbolt/jsbeeb/issues/536)) ([64c8043](https://github.com/mattgodbolt/jsbeeb/commit/64c80438bf7c0f87db993b9a878665e3d3b090bc))
* add snapshotState/restoreState to FakeVideo and FakeSoundChip ([#607](https://github.com/mattgodbolt/jsbeeb/issues/607)) ([e42271a](https://github.com/mattgodbolt/jsbeeb/commit/e42271aed863ef882eb72ec066f3abd0f7bcf2da))
* always feed SAA5050 teletext pipeline from video bus ([#578](https://github.com/mattgodbolt/jsbeeb/issues/578)) ([7ff0e12](https://github.com/mattgodbolt/jsbeeb/commit/7ff0e1223b37571c26d07865b7daff0b672e8d1d))
* apply NULA paletteMode in blitter to bypass ULA XOR-7 mapping ([#583](https://github.com/mattgodbolt/jsbeeb/issues/583)) ([49ae587](https://github.com/mattgodbolt/jsbeeb/commit/49ae587eebd0b131f10f3f5106c1b70baf2b741a))
* apply Steady teletext code as Set At, not Set After ([#613](https://github.com/mattgodbolt/jsbeeb/issues/613)) ([8625dc5](https://github.com/mattgodbolt/jsbeeb/commit/8625dc5ad62569ee10becf28ca25331584183b3a))
* chdir to public/ so ROM loader finds public/roms/ when installed from npm ([#560](https://github.com/mattgodbolt/jsbeeb/issues/560)) ([593b819](https://github.com/mattgodbolt/jsbeeb/commit/593b81914d8969d9f699812c66fda4c40e5b32b8))
* consistent button2 mapping for gamepad fire buttons ([#604](https://github.com/mattgodbolt/jsbeeb/issues/604)) ([f5da9d6](https://github.com/mattgodbolt/jsbeeb/commit/f5da9d6cf9e7adaead93bcb68c6e849d8df09f5e)), closes [#503](https://github.com/mattgodbolt/jsbeeb/issues/503)
* correct 65C12 timing for dead cycles, RMW spurious ops, and ACCCON TST ([#597](https://github.com/mattgodbolt/jsbeeb/issues/597)) ([f05826a](https://github.com/mattgodbolt/jsbeeb/commit/f05826a4e62b7391cfef78d5e1641e42be9d5825))
* correct default CMOS FDRIVE step rate for BBC Master ([#581](https://github.com/mattgodbolt/jsbeeb/issues/581)) ([b1f71dc](https://github.com/mattgodbolt/jsbeeb/commit/b1f71dc52f491545c67885b961aa382b9ee7cb7a))
* decrement SP by 3 during reset sequence ([#547](https://github.com/mattgodbolt/jsbeeb/issues/547)) ([#549](https://github.com/mattgodbolt/jsbeeb/issues/549)) ([a08f9ff](https://github.com/mattgodbolt/jsbeeb/commit/a08f9ff9c0513d84792138b1a2c6e5d01912de07))
* Electron menu actions broken by Rolldown's export let optimization ([#624](https://github.com/mattgodbolt/jsbeeb/issues/624)) ([26c50ce](https://github.com/mattgodbolt/jsbeeb/commit/26c50ce8f932e54b8fa6a04074d272ce32c7bbe3))
* emulate IC37/IC36 H-blanking feed for SAA5050 pipeline (issue [#546](https://github.com/mattgodbolt/jsbeeb/issues/546)) ([#580](https://github.com/mattgodbolt/jsbeeb/issues/580)) ([7399552](https://github.com/mattgodbolt/jsbeeb/commit/7399552f345e35d7ca4f3276a62dada36cdaed2c))
* enable window scaling in Electron and modernize event handlers ([#533](https://github.com/mattgodbolt/jsbeeb/issues/533)) ([64551c9](https://github.com/mattgodbolt/jsbeeb/commit/64551c9d53c3a1a253dd1ac8f6b0f9dd9f266272))
* Fix Windows Build support ([8ffa1a0](https://github.com/mattgodbolt/jsbeeb/commit/8ffa1a037fdfd7e38e072dca65da5b1959823fb2))
* focus STH archive filter input when modal opens ([#573](https://github.com/mattgodbolt/jsbeeb/issues/573)) ([b0d5c74](https://github.com/mattgodbolt/jsbeeb/commit/b0d5c743321322fc82ff7b26538f8b492c9b4c86))
* pad SSD/DSD disc images that aren't a multiple of sector size ([#602](https://github.com/mattgodbolt/jsbeeb/issues/602)) ([2b5e9e1](https://github.com/mattgodbolt/jsbeeb/commit/2b5e9e194a984ba600eb9e91a8899eecef1cf2d0)), closes [#601](https://github.com/mattgodbolt/jsbeeb/issues/601)
* produce ^ from shift-6 in natural keyboard layout ([#605](https://github.com/mattgodbolt/jsbeeb/issues/605)) ([ff4388a](https://github.com/mattgodbolt/jsbeeb/commit/ff4388ae29762531d079d48190045529e791f032))
* reduce WD1770 head settle time from 30ms to 15ms ([#577](https://github.com/mattgodbolt/jsbeeb/issues/577)) ([7b6a068](https://github.com/mattgodbolt/jsbeeb/commit/7b6a068603d66c2feb373beed8958bb7fd8f3639))
* remove invalid package-name parameter from release-please action ([#535](https://github.com/mattgodbolt/jsbeeb/issues/535)) ([5dd0436](https://github.com/mattgodbolt/jsbeeb/commit/5dd043601282e1aae976a8cd58c2071bd2b15954))
* replace debugInstruction hook with scheduler for paste ([#609](https://github.com/mattgodbolt/jsbeeb/issues/609)) ([f3a8216](https://github.com/mattgodbolt/jsbeeb/commit/f3a821685237ff2f2c05b840edc582d704678ce5))
* speak each CR-terminated line immediately, queue without cancel ([#570](https://github.com/mattgodbolt/jsbeeb/issues/570)) ([6c2bd37](https://github.com/mattgodbolt/jsbeeb/commit/6c2bd37b5321c23d48588f4f13937a8338c49af9))
* use Node 24 in npm-publish job — npm v10 (Node 22) doesn't support OIDC trusted publishing ([#557](https://github.com/mattgodbolt/jsbeeb/issues/557)) ([f8ff684](https://github.com/mattgodbolt/jsbeeb/commit/f8ff6841afa30c88dd502bb8acd297db1ef299c9))

## [1.10.1](https://github.com/mattgodbolt/jsbeeb/compare/v1.10.0...v1.10.1) (2026-04-04)


### Bug Fixes

* Electron menu actions broken by Rolldown's export let optimization ([#624](https://github.com/mattgodbolt/jsbeeb/issues/624)) ([26c50ce](https://github.com/mattgodbolt/jsbeeb/commit/26c50ce8f932e54b8fa6a04074d272ce32c7bbe3))

## [1.10.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.9.1...v1.10.0) (2026-04-03)


### Features

* cassette motor relay click sound with audio refactor ([#582](https://github.com/mattgodbolt/jsbeeb/issues/582)) ([05906c3](https://github.com/mattgodbolt/jsbeeb/commit/05906c380153e278e542da7336dfbac652a17710))


### Bug Fixes

* apply Steady teletext code as Set At, not Set After ([#613](https://github.com/mattgodbolt/jsbeeb/issues/613)) ([8625dc5](https://github.com/mattgodbolt/jsbeeb/commit/8625dc5ad62569ee10becf28ca25331584183b3a))
* replace debugInstruction hook with scheduler for paste ([#609](https://github.com/mattgodbolt/jsbeeb/issues/609)) ([f3a8216](https://github.com/mattgodbolt/jsbeeb/commit/f3a821685237ff2f2c05b840edc582d704678ce5))

## [1.9.1](https://github.com/mattgodbolt/jsbeeb/compare/v1.9.0...v1.9.1) (2026-03-26)


### Bug Fixes

* add snapshotState/restoreState to FakeVideo and FakeSoundChip ([#607](https://github.com/mattgodbolt/jsbeeb/issues/607)) ([e42271a](https://github.com/mattgodbolt/jsbeeb/commit/e42271aed863ef882eb72ec066f3abd0f7bcf2da))

## [1.9.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.8.0...v1.9.0) (2026-03-26)


### Features

* snapshot SWRAM, add capture API to TestMachine ([#606](https://github.com/mattgodbolt/jsbeeb/issues/606)) ([08c20de](https://github.com/mattgodbolt/jsbeeb/commit/08c20dece7ee19a1807aa4cc637031dda2b53bbe))


### Bug Fixes

* consistent button2 mapping for gamepad fire buttons ([#604](https://github.com/mattgodbolt/jsbeeb/issues/604)) ([f5da9d6](https://github.com/mattgodbolt/jsbeeb/commit/f5da9d6cf9e7adaead93bcb68c6e849d8df09f5e)), closes [#503](https://github.com/mattgodbolt/jsbeeb/issues/503)
* pad SSD/DSD disc images that aren't a multiple of sector size ([#602](https://github.com/mattgodbolt/jsbeeb/issues/602)) ([2b5e9e1](https://github.com/mattgodbolt/jsbeeb/commit/2b5e9e194a984ba600eb9e91a8899eecef1cf2d0)), closes [#601](https://github.com/mattgodbolt/jsbeeb/issues/601)
* produce ^ from shift-6 in natural keyboard layout ([#605](https://github.com/mattgodbolt/jsbeeb/issues/605)) ([ff4388a](https://github.com/mattgodbolt/jsbeeb/commit/ff4388ae29762531d079d48190045529e791f032))

## [1.8.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.7.0...v1.8.0) (2026-03-24)


### Features

* TestMachine case handling, keyDown/keyUp, loadSidewaysRam ([#598](https://github.com/mattgodbolt/jsbeeb/issues/598)) ([ba6b656](https://github.com/mattgodbolt/jsbeeb/commit/ba6b6569921363cb59a5dfc143aa170cee2c08dd))

## [1.7.0](https://github.com/mattgodbolt/jsbeeb/compare/v1.6.0...v1.7.0) (2026-03-22)


### Features

* add FDC, disc drive, and disc snapshot/restore (v2 format) ([#592](https://github.com/mattgodbolt/jsbeeb/issues/592)) ([e7ac8db](https://github.com/mattgodbolt/jsbeeb/commit/e7ac8db0199889c50cc9a30b43948c0c4607700c))
* add rewind scrubber UI with thumbnail filmstrip ([#588](https://github.com/mattgodbolt/jsbeeb/issues/588)) ([78166cc](https://github.com/mattgodbolt/jsbeeb/commit/78166cc7f648b5a04a1a216d2db4fe21e0efc5a7))
* Fix debugInstruction breakpoints and make type() hook-based ([#593](https://github.com/mattgodbolt/jsbeeb/issues/593)) ([00da081](https://github.com/mattgodbolt/jsbeeb/commit/00da081318fef96194373672618c99ef41396861))
* persist dirty disc data and embedded images in snapshots ([#594](https://github.com/mattgodbolt/jsbeeb/issues/594)) ([c4fe340](https://github.com/mattgodbolt/jsbeeb/commit/c4fe34044345f8dae616878ed95e71fc51fe1570))


### Bug Fixes

* correct 65C12 timing for dead cycles, RMW spurious ops, and ACCCON TST ([#597](https://github.com/mattgodbolt/jsbeeb/issues/597)) ([f05826a](https://github.com/mattgodbolt/jsbeeb/commit/f05826a4e62b7391cfef78d5e1641e42be9d5825))

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
