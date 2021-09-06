define(['three', 'jquery', 'utils', 'three-mtl-loader', 'three-obj-loader', 'three-orbit'], function (THREE, $, utils) {
    "use strict";

    function skyLight() {
        const skyColor = 0xB1E1FF;  // light blue
        const groundColor = 0xB97A20;  // brownish orange
        const intensity = 0.8;
        return new THREE.HemisphereLight(skyColor, groundColor, intensity);
    }

    function directionalLight() {
        const color = 0xFFFFFF;
        const intensity = 0.7;
        const light = new THREE.DirectionalLight(color, intensity);
        light.position.set(5, 10, 2);
        return light;
    }

    const LeftShiftIndex = 60;
    const RightShiftIndex = 71;

    function remapKey(keyIndex) {
        const rowCol = ((keyIndex) => {
            const BBC = utils.BBC;
            if (keyIndex < 10)
                return BBC[`F${keyIndex}`];
            if (keyIndex >= 28 && keyIndex < 38)
                return BBC[`K${(keyIndex - 28) % 10}`];
            switch (keyIndex) {
                case 27:
                    break; // BREAK
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

                case 38:
                    return BBC.W;
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
                    return BBC.DELETE; // seems attached to right shift in the model currently
                case 73:
                    return BBC.COPY; // seems attached to right shift in the model currently
            }
            return null;
        })(keyIndex);
        if (rowCol === null) return -1;
        return rowCol[0] * 16 + rowCol[1];
    }

    class FrameBuffer {
        constructor(width, height) {
            this.fb8 = new Uint8Array(width * height * 4);
            this.fb32 = new Uint32Array(this.fb8.buffer);

            this.dataTexture = new THREE.DataTexture(
                this.fb8,
                width,
                height,
                THREE.RGBAFormat,
                THREE.UnsignedByteType,
                THREE.CubeRefractionMapping
            );
            this.dataTexture.needsUpdate = true;
            this.dataTexture.flipY = true;
            this.dataTexture.repeat.set(0.75, 0.75);
            this.dataTexture.offset.set(0.15, 0.3);
        }
    }

    class ThreeCanvas {
        constructor(canvas) {
            const attrs = {
                alpha: false,
                antialias: true,
                canvas: canvas
            };

            this.renderer = new THREE.WebGLRenderer(attrs);
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.scene = new THREE.Scene();
            this.buffer = new FrameBuffer(1024, 1024);
            this.fb32 = new Uint32Array(1024 * 1024);
            this.cpu = null;

            // Set the background color
            this.scene.background = new THREE.Color('#222222');

            // Create a camera
            const fov = 35;
            const aspectRatio = 640 / 512;
            const near = 1;
            const far = 1000;
            this.camera = new THREE.PerspectiveCamera(fov, aspectRatio, near, far);
            this.camera.position.set(0, 20, 36.5);

            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.target.set(0, 7, -2.36);

            this.scene.add(skyLight());
            const dirLight = directionalLight();
            this.scene.add(dirLight);
            this.scene.add(dirLight.target);

            {
               const loader = new THREE.TextureLoader();
               const texture = loader.load(
                 './virtual-beeb/textures/equirectangular-bg.jpg',
                 () => {
                   this.rt = new THREE.WebGLCubeRenderTarget(texture.image.height);
                   this.rt.fromEquirectangularTexture(this.renderer, texture);
                   this.scene.background = this.rt.texture;
                 });
             }

            this.keys = {};
            this.leftShiftKey = null;
            this.rightShiftKey = null;
            this.screenMaterial = null;
            this.casetteLed = null;
            this.capsLed = null;
            this.shiftLed = null;

            this.load();

            $(this.renderer.domElement).remove().appendTo($('#outer'));
            $('#cub-monitor').hide();
            console.log("Three Canvas set up");
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

        load() {
            const mtlLoader = new THREE.MTLLoader();
            mtlLoader.load('./virtual-beeb/models/beeb.mtl', (mtl) => {
                mtl.preload();
                const objLoader = new THREE.OBJLoader();
                objLoader.setMaterials(mtl);
                objLoader.load('./virtual-beeb/models/beeb.obj', (root) => {
                    root.scale.set(50, 50, 50);
                    this.scene.add(root);

                    const name = /JOINED_KEYBOARD\.([0-9]{3})_Cube\..*/;
                    this.scene.traverse(child => {
                        const match = child.name.match(name);
                        if (match) {
                            const keyIndex = parseInt(match[1]);
                            if (keyIndex === LeftShiftIndex) {
                                this.leftShiftKey = child;
                            } else if (keyIndex === RightShiftIndex) {
                                this.rightShiftKey = child;
                            } else {
                                this.keys[remapKey(keyIndex)] = child;
                            }
                        }
                        //  List out all the object names from the import - very useful!
                        console.log(child.name);
                    });

                    // Initial CRT glass
                    this.glassMaterial = new THREE.MeshPhysicalMaterial({
                                          metalness: .9,
                                          roughness: .05,
                                          envMapIntensity: 0.8,
                                          clearcoat: 1,
                                          transparent: true,
                                          opacity: 0.5,
                                          reflectivity: 0.3,
                                          refractionRatio:11,
                                          ior: 0.9,
                                          side: THREE.FrontSide,
                                          envMap: this.rt.texture
                                        })

                    const glass = this.scene.getObjectByName("SCREEN_SurfPatch.002");
                    glass.material = this.glassMaterial;

                    // Spacebar material
                    const spaceBar = this.scene.getObjectByName("JOINED_KEYBOARD.026_Cube.039");
                    spaceBar.material = new THREE.MeshPhongMaterial({
                                                color: 0x000000,
                                                shininess: 10,
                                                specular: 0x111111
                                            })

                    // Attempt at phosphor screen on the interior of the CRT
                    this.screenMaterial = new THREE.MeshBasicMaterial(
                        {
                            transparent: false,
                            map: this.buffer.dataTexture,
                            emissive: true
                        });
                    const screen = this.scene.getObjectByName("SCREEN_PLANE_Plane.003");
                    screen.material = this.screenMaterial;

                    this.casetteLed = this.setupLed(this.scene.getObjectByName("LED_INLAY.001_Cube.085"));
                    this.capsLed = this.setupLed(this.scene.getObjectByName("LED_INLAY.002_Cube.086"));
                    this.shiftLed = this.setupLed(this.scene.getObjectByName("LED_INLAY_Cube.019"));
                });
            });
        }

        updateKey(key, pressed) {
            if (!key) return;
            const springiness = 0.8;
            const target = pressed ? -0.005 : 0;
            key.position.y += (target - key.position.y) * springiness;
        }

        frame() {
            this.controls.update();
            this.renderer.render(this.scene, this.camera);

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

            this.updateLed(this.casetteLed, this.cpu.acia.motorOn);
            this.updateLed(this.capsLed, this.cpu.sysvia.capsLockLight);
            this.updateLed(this.shiftLed, this.cpu.sysvia.shiftLockLight);

            return true;
        }

        setProcessor(cpu) {
            this.cpu = cpu;
        }

        handleResize(width, height) {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
            return true;
        }

        paint(minx, miny, maxx, maxy) {
            if (!this.screenMaterial) return;
            this.screenMaterial.map.needsUpdate = true;
            // Ideally we'd update everything to write to one of two double buffers, but there's too many places in the
            // code that cache the fb32 for now. So just copy it.
            // TODO: fix
            // TODO: subset at least based on miny, maxy?
            this.buffer.fb32.set(this.fb32);
        }
    }

    return ThreeCanvas;
});
