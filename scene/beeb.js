define(['three', '../utils', 'three-mtl-loader', 'three-obj-loader', 'three-orbit'], function (THREE, utils) {
    "use strict";

    function remapKey(keyIndex) {
        const rowCol = ((keyIndex) => {
            const BBC = utils.BBC;
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
        })(keyIndex);
        if (rowCol === null) return -1;
        return rowCol[0] * 16 + rowCol[1];
    }

    async function loadModel(materials) {
        const objLoader = new THREE.OBJLoader();
        objLoader.setMaterials(materials);
        return utils.promisifyLoad(objLoader, './virtual-beeb/models/beeb.obj');
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

    async function loadMaterials() {
        const materials = await utils.promisifyLoad(new THREE.MTLLoader(), './virtual-beeb/models/beeb.mtl');
        materials.preload();
        return materials;
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
            const [materials, maskTexture, screenPrologFragment, screenEmissiveFragment, screenEpilogFragment] = await Promise.all(
                [
                    loadMaterials(),
                    loadMaskTexture(),
                    loadShaderSource('scene/screen_prolog.glsl'),
                    loadShaderSource('scene/screen_emissive.glsl'),
                    loadShaderSource('scene/screen_epilog.glsl')
                ]);
            this.screenMaterial = this.makeScreenMaterial(maskTexture, screenPrologFragment, screenEmissiveFragment, screenEpilogFragment);
            this.model = this.prepareModel(await loadModel(materials));
        }

        setupLed(obj) {
            // Replace the material with our own.
            const material = obj.material[1].clone(); // Hacky but works for now, TODO look into alternatives
            obj.material[1] = material;
            return material;
        }

        updateLed(led, on) {
            if (!led) return;
            led.emissive.set(on ? 0xff0000 : 0);
        }

        updateKey(key, pressed) {
            if (!key) return;
            const springiness = 0.8;
            const target = pressed ? -0.005 : 0;
            key.position.y += (target - key.position.y) * springiness;
        }

        onPaint() {
            this.screenMaterial.emissiveMap.needsUpdate = true;
        }

        update(cpu, time) {
            // Update the key animations.
            const sysvia = cpu.sysvia;
            for (let i = 0; i < sysvia.keys.length; ++i) {
                const row = sysvia.keys[i];
                for (let j = 0; j < row.length; ++j) {
                    if (this.keys[i * 16 + j]) this.updateKey(this.keys[i * 16 + j], row[j]);
                }
            }

            this.updateKey(this.leftShiftKey, sysvia.leftShiftDown);
            this.updateKey(this.rightShiftKey, sysvia.rightShiftDown);
            this.updateKey(this.breakKey, !cpu.resetLine);

            this.updateLed(this.casetteLed, cpu.acia.motorOn);
            this.updateLed(this.capsLed, cpu.sysvia.capsLockLight);
            this.updateLed(this.shiftLed, cpu.sysvia.shiftLockLight);

            if (this.screenMaterial.shaderUniforms) {
                // https://github.com/mrdoob/three.js/issues/11475
                this.screenMaterial.shaderUniforms.time.value = time / 1000;
            }
        }

        makeScreenMaterial(maskTexture, screenPrologFragment, screenEmissiveFragment, screenEpilogFragment) {
            const screenMaterial = new THREE.MeshStandardMaterial({
                transparent: false,
                color: 0x102018,
                emissiveMap: this.screenTexture,
                roughness: 0.0,
                emissive: 0xffffff,
                envMap: this.envMap,
            });

            const newUniforms = {
                maskTexture: {type: "t", value: maskTexture}
            };

            // we use onBeforeCompile() to modify one of the standard threejs shaders
            screenMaterial.onBeforeCompile = shader => {

                shader.uniforms.maskTexture = newUniforms.maskTexture;
                shader.uniforms.time = {value: 0};

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

        prepareModel(beeb) {
            beeb.scale.set(50, 50, 50);
            const name = /JOINED_KEYBOARD(\.([0-9]{3}))?_Cube\..*/;
            beeb.traverse(child => {
                const match = child.name.match(name);
                if (match) {
                    const keyIndex = match[1] ? parseInt(match[2]) : 0;
                    switch (keyIndex) {
                        case LeftShiftIndex:
                            this.leftShiftKey = child;
                            break;
                        case RightShiftIndex:
                            this.rightShiftKey = child;
                            break;
                        case BreakIndex:
                            this.breakKey = child;
                            break;
                        default:
                            this.keys[remapKey(keyIndex)] = child;
                            break;
                    }
                }
                //  List out all the object names from the import - very useful!
                // console.log(child.name);
            });

            const glass = beeb.getObjectByName("SCREEN_SurfPatch.002");
            glass.material = this.screenMaterial;

            // Spacebar material
            const spaceBar = beeb.getObjectByName("JOINED_KEYBOARD.026_Cube.039");
            spaceBar.material = new THREE.MeshStandardMaterial({
                color: 0x000000,
                roughness: 0.05
            });

            // Set the screen plane to black
            const screen = beeb.getObjectByName("SCREEN_PLANE_Plane.003");

            screen.material = new THREE.MeshStandardMaterial({
                color: 0x000000,
                shininess: 10,
                specular: 0x111111
            });

            this.casetteLed = this.setupLed(beeb.getObjectByName("LED_INLAY.001_Cube.085"));
            this.capsLed = this.setupLed(beeb.getObjectByName("LED_INLAY.002_Cube.086"));
            this.shiftLed = this.setupLed(beeb.getObjectByName("LED_INLAY_Cube.019"));
            return beeb;
        }
    }

    async function loadBeeb(envMap, screenTexture) {
        const beeb = new Beeb(envMap, screenTexture);
        await beeb.load();
        return beeb;
    }

    return loadBeeb;
});