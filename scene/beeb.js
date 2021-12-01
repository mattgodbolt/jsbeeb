define(['three', '../utils', 'three-gltf-loader'], function (THREE, utils) {
    "use strict";

    function keyIndexToBeebIndex(BBC, keyIndex) {
        if (keyIndex < 10)
            return BBC[`F${keyIndex}`];
        if (keyIndex >= 29 && keyIndex <= 38)
            return BBC[`K${(keyIndex - 28) % 10}`];
        switch (keyIndex) {
            case 10:
                return BBC.SHIFTLOCK;
            case 11:
                return BBC.TAB;
            case 12:
                return BBC.CAPSLOCK;
            case 28:
                return BBC.ESCAPE;

            case 13:
                return BBC.CTRL;
            case 14:
                return BBC.A;
            case 15:
                return BBC.S;
            case 16:
                return BBC.D;
            case 17:
                return BBC.F;
            case 18:
                return BBC.G;
            case 19:
                return BBC.H;
            case 20:
                return BBC.J;
            case 21:
                return BBC.K;
            case 22:
                return BBC.L;
            case 23:
                return BBC.SEMICOLON_PLUS;
            case 24:
                return BBC.COLON_STAR;
            case 25:
                return BBC.RIGHT_SQUARE_BRACKET;
            case 26:
                return BBC.SPACE;

            case 39:
                return BBC.MINUS;
            case 40:
                return BBC.HAT_TILDE;
            case 41:
                return BBC.PIPE_BACKSLASH;
            case 42:
                return BBC.LEFT;
            case 43:
                return BBC.RIGHT;

            case 44:
                return BBC.Q;
            case 45:
                return BBC.W;
            case 46:
                return BBC.E;
            case 47:
                return BBC.R;
            case 48:
                return BBC.T;
            case 49:
                return BBC.Y;
            case 50:
                return BBC.U;
            case 51:
                return BBC.I;
            case 52:
                return BBC.O;
            case 53:
                return BBC.P;
            case 54:
                return BBC.AT;
            case 55:
                return BBC.LEFT_SQUARE_BRACKET;
            case 56:
                return BBC.UNDERSCORE_POUND;
            case 57:
                return BBC.UP;
            case 58:
                return BBC.DOWN;

            case 59:
                return BBC.RETURN;

            case 61:
                return BBC.Z;
            case 62:
                return BBC.X;
            case 63:
                return BBC.C;
            case 64:
                return BBC.V;
            case 65:
                return BBC.B;
            case 66:
                return BBC.N;
            case 67:
                return BBC.M;
            case 68:
                return BBC.COMMA;
            case 69:
                return BBC.PERIOD;
            case 70:
                return BBC.SLASH;
            case 72:
                return BBC.DELETE;
            case 73:
                return BBC.COPY;
        }
        return null;
    }

    function remapKey(keyIndex) {
        const rowCol = keyIndexToBeebIndex(utils.BBC, keyIndex);
        if (rowCol === null) return -1;
        return rowCol[0] * 16 + rowCol[1];
    }

    async function loadModel() {
        const objLoader = new THREE.GLTFLoader();
        const model = await utils.promisifyLoad(objLoader, './virtual-beeb/models/beeb.glb');
        return model.scene;
    }

    async function loadMaskTexture() {
        const maskTexture = await utils.promisifyLoad(new THREE.TextureLoader(), './virtual-beeb/textures/mask.png');

        maskTexture.magFilter = THREE.LinearFilter;
        maskTexture.minFilter = THREE.LinearMipmapLinearFilter;

        maskTexture.wrapS = THREE.RepeatWrapping;
        maskTexture.wrapT = THREE.RepeatWrapping;

        maskTexture.encoding = THREE.sRGBEncoding;

        return maskTexture;
    }

    async function loadShaderSource(fileName) {
        const response = await fetch(fileName);
        return response.text();
    }

    const BreakIndex = 27;
    const LeftShiftIndex = 60;
    const RightShiftIndex = 71;

    class Beeb {
        constructor(envMap, screenTexture) {
            this.envMap = envMap;
            this.screenTexture = screenTexture;
            this.model = null;
            this.cpu = null;
            this.keys = {};
            this.leftShiftKey = null;
            this.rightShiftKey = null;
            this.breakKey = null;
            this.screenMaterial = null;
            this.casetteLed = null;
            this.capsLed = null;
            this.shiftLed = null;
        }

        async load() {
            const [maskTexture, screenPrologFragment, screenEmissiveFragment, screenEpilogFragment, model] = await Promise.all(
                [
                    loadMaskTexture(),
                    loadShaderSource('scene/screen_prolog.glsl'),
                    loadShaderSource('scene/screen_emissive.glsl'),
                    loadShaderSource('scene/screen_epilog.glsl'),
                    loadModel()
                ]);
            this.screenMaterial = this.makeScreenMaterial(maskTexture, screenPrologFragment, screenEmissiveFragment, screenEpilogFragment);
            this.model = this.prepareScene(model);
        }

        setupLed(obj) {
            // Replace the material with our own.
            const led = obj.children[1];
            const material = led.material.clone(); // Hacky but works for now, TODO look into alternatives
            led.material = material;
            return material;
        }

        updateLed(led, on) {
            if (!led) return;
            led.emissive.set(on ? 0xff0000 : 0);
        }

        updateKey(key, pressed) {
            const KeyTravelMm = 3;
            if (!key) return;
            const springiness = pressed ? 0.9 : 0.5;
            const originalY = key.originalPosition.y;
            const target = pressed ? originalY - (KeyTravelMm / 1000.0) : originalY;
            key.position.y += (target - key.position.y) * springiness;
        }

        onPaint() {
            this.screenMaterial.emissiveMap.needsUpdate = true;
        }

        setProcessor(cpu) {
            this.cpu = cpu;
        }

        update(time) {
            // Update the key animations.
            const sysvia = this.cpu.sysvia;
            for (let i = 0; i < sysvia.keys.length; ++i) {
                const row = sysvia.keys[i];
                for (let j = 0; j < row.length; ++j) {
                    if (this.keys[i * 16 + j]) this.updateKey(this.keys[i * 16 + j], row[j]);
                }
            }

            this.updateKey(this.leftShiftKey, sysvia.leftShiftDown);
            this.updateKey(this.rightShiftKey, sysvia.rightShiftDown);
            this.updateKey(this.breakKey, !this.cpu.resetLine);

            this.updateLed(this.casetteLed, this.cpu.acia.motorOn);
            this.updateLed(this.capsLed, this.cpu.sysvia.capsLockLight);
            this.updateLed(this.shiftLed, this.cpu.sysvia.shiftLockLight);

            if (this.screenMaterial.shaderUniforms) {
                // https://github.com/mrdoob/three.js/issues/11475
                this.screenMaterial.shaderUniforms.time.value = time / 1000;
            }
        }

        makeScreenMaterial(maskTexture, screenPrologFragment, screenEmissiveFragment, screenEpilogFragment) {
            const screenMaterial = new THREE.MeshPhysicalMaterial({
                transparent: false,
                color: 0x040504,
                emissiveMap: this.screenTexture,
                roughness: 0.0,
                emissive: 0xffffff,
                reflectivity: 0.02,
                envMap: this.envMap,
            });

            const newUniforms = {
                maskTexture: { type: "t", value: maskTexture }
            };

            // we use onBeforeCompile() to modify one of the standard threejs shaders
            screenMaterial.onBeforeCompile = shader => {

                shader.uniforms.maskTexture = newUniforms.maskTexture;
                shader.uniforms.time = { value: 0 };

                shader.fragmentShader = shader.fragmentShader.replace(
                    `#include <common>`,
                    screenPrologFragment + '\n#include <common>');

                shader.fragmentShader = shader.fragmentShader.replace(
                    `#include <emissivemap_fragment>`,
                    screenEmissiveFragment);

                shader.fragmentShader = shader.fragmentShader.replace(
                    `#include <aomap_fragment>`,
                    '#include <aomap_fragment>\n' + screenEpilogFragment);

                //console.log("--- Shader Begin ---");
                //console.log(shader.fragmentShader);
                //console.log("--- Shader End ---");

                screenMaterial.shaderUniforms = shader.uniforms;
            };

            return screenMaterial;
        }

        prepareScene(scene) {
            // scene.traverse(child => console.log(child.name));
            scene.scale.set(50, 50, 50);
            this.prepareBeeb(scene);
            this.prepareMonitor(scene.getObjectByName("Monitor"));
            return scene;
        }

        prepareMonitor(monitor) {
            const frame = monitor.getObjectByName("SCREENFRAME");
            const glass = frame.getObjectByName("SCREEN");
            glass.material = this.screenMaterial;

            // we don't really need to override this in code any more
            // It was used when the glass was transparent
            // we are now using it to set a slightly different colour and adjust the roughness on the material
            const screen = frame.getObjectByName("Plane");
            screen.material = new THREE.MeshPhysicalMaterial({
                color: 0x030201,
                roughness: 0.5
            });
        }

        setupKey(key, keyIndex) {
            key.originalPosition = key.position.clone();

            switch (keyIndex) {
                case LeftShiftIndex:
                    this.leftShiftKey = key;
                    key.onDown = () => {
                        if (!this.cpu) return;
                        this.cpu.sysvia.keyDown(utils.keyCodes.SHIFT_LEFT);
                    };
                    key.onUp = () => {
                        if (!this.cpu) return;
                        this.cpu.sysvia.keyUp(utils.keyCodes.SHIFT_LEFT);
                    };
                    break;
                case RightShiftIndex:
                    this.rightShiftKey = key;
                    key.onDown = () => {
                        if (!this.cpu) return;
                        this.cpu.sysvia.keyDown(utils.keyCodes.SHIFT_RIGHT);
                    };
                    key.onUp = () => {
                        if (!this.cpu) return;
                        this.cpu.sysvia.keyUp(utils.keyCodes.SHIFT_RIGHT);
                    };
                    break;
                case BreakIndex:
                    this.breakKey = key;
                    key.onDown = () => {
                        if (!this.cpu) return;
                        this.cpu.setReset(true);
                    };
                    key.onUp = () => {
                        if (!this.cpu) return;
                        this.cpu.setReset(false);
                    };
                    break;
                default:
                    const keyCode = remapKey(keyIndex);
                    this.keys[keyCode] = key;
                    const rawIndex = [keyCode >>> 4, keyCode % 16];
                    key.onDown = () => {
                        if (!this.cpu) return;
                        this.cpu.sysvia.keyDownRaw(rawIndex);
                    };
                    key.onUp = () => {
                        if (!this.cpu) return;
                        this.cpu.sysvia.keyUpRaw(rawIndex);
                    };
                    break;
            }
        }

        prepareBeeb(beebModel) {
            let perspexBlock = beebModel.getObjectByName("Keyboard_CLEAR_PLASTIC_BLOCK");
            perspexBlock.material = new THREE.MeshPhysicalMaterial({
                roughness: 0,
                transmission: 0.8,
                transparent: true,
                thickness: 0,
                envMap: this.envMap,
                opacity: 1, // 1 as we don't want the material to fade out, we can adjust how much the diffuse light affects things with transmission.
                metalness: 0,
                color: 0xeeeeee
            });

            const keyboard = beebModel;
            const name = /JOINED_KEYBOARD(\.?([0-9]{3}))?.*/;
            keyboard.traverse(child => {
                const match = child.name.match(name);
                if (match) {
                    const keyIndex = match[1] ? parseInt(match[2]) : 0;
                    this.setupKey(child, keyIndex);
                }
            });


            this.casetteLed = this.setupLed(keyboard.getObjectByName("LED_CASSETTE"));
            this.capsLed = this.setupLed(keyboard.getObjectByName("LED_CAPS_LOCK"));
            this.shiftLed = this.setupLed(keyboard.getObjectByName("LED_SHIFT_LOCK"));
        }
    }

    async function loadBeeb(envMap, screenTexture) {
        const beeb = new Beeb(envMap, screenTexture);
        await beeb.load();
        return beeb;
    }

    return loadBeeb;
});
