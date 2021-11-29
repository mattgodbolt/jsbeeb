define(['three', 'jquery', 'utils', 'scene/beeb', 'underscore', 'three-mtl-loader', 'three-obj-loader', 'three-orbit'], function (THREE, $, utils, loadBeeb, _) {
    "use strict";

    function skyLight() {
        const intensity = 0.1;
        const skyColor = 0xffffbb;
        const groundColor = 0x080820;
        const light = new THREE.HemisphereLight( skyColor, groundColor, intensity );
        return light;
    }

    function directionalLight() {
        const color = 0xfff0e0;
        const intensity = 1;
        const light = new THREE.DirectionalLight(color, intensity);
        light.position.set(-0.5, 1, 1);
        light.castShadow = true;
        return light;
    }

    class ClickControls {
        constructor(domElement, scene, camera, orbitControls, keyboardGroup) {
            this.domElement = domElement;
            this.domElement.addEventListener("pointerdown", event => this.onDown(event), false);
            this.domElement.addEventListener("pointerup", event => this.onUp(event), false);
            this.domElement.addEventListener("mousemove", event => this.onMove(event), false);
            this.downObj = null;
            this.isTracking = false;
            this.scene = scene;
            this.camera = camera;
            this.raycaster = new THREE.Raycaster();
            this.orbitControls = orbitControls;
            this._setDown = _.throttle(this._setDown, 45);
            this.keyboardGroup = keyboardGroup
        }

        getCanvasRelativePosition(event) {
            const rect = this.domElement.getBoundingClientRect();
            return {
                x: (event.clientX - rect.left) * this.domElement.width / rect.width,
                y: (event.clientY - rect.top) * this.domElement.height / rect.height,
            };
        }

        getObjectForEvent(event) {
            const pos = this.getCanvasRelativePosition(event);
            const normalizedPosition = {
                x: (pos.x / this.domElement.width) * 2 - 1,
                y: (pos.y / this.domElement.height) * -2 + 1
            };
            this.raycaster.setFromCamera(normalizedPosition, this.camera);
            // get the list of objects the ray intersected
            const intersectedObjects = this.raycaster.intersectObjects(this.keyboardGroup.children, true);
                // TODO factor in the 'step height' of keyboard rows

            if (!intersectedObjects.length) return null;

            // We're only intersecting with one key
            if (intersectedObjects.length===1) return intersectedObjects[0].object;

            // The second key is one we're already pressing
            if (intersectedObjects[1].object === this.downObj) {
                return intersectedObjects[1].object;
            }

            // Its the same key as before, or we are pressing the top
            if (intersectedObjects[0].point.y > 2.6 || intersectedObjects[0].object === this.downObj) {
                return intersectedObjects[0].object;
            }

            return null
        }

        _setDown(obj) {
            if (obj === this.downObj)
                return;
            if (this.downObj) {
                if (this.downObj.onUp)
                    this.downObj.onUp();
                this.downObj = null;
            }
            this.downObj = obj;
            if (this.downObj && this.downObj.onDown)
                this.downObj.onDown();
        }

        onMove(event) {
            if (this.isTracking)
                this._setDown(this.getObjectForEvent(event));
        }

        onDown(event) {
            const eventObj = this.getObjectForEvent(event);
            this._setDown(eventObj);
            // Track movements only if we clicked on something in the viewport.
            this.isTracking = eventObj !== null;
            if (this.isTracking)
                this.orbitControls.enabled = false;
        }

        onUp() {
            this.isTracking = false;
            this.orbitControls.enabled = true;
            this._setDown(null);
        }
    }

    class FrameBuffer {
        constructor(width, height) {
            this.fb8 = new Uint8Array(width * height * 4);
            this.fb32 = new Uint32Array(this.fb8.buffer);

            const anisotropy = 8.0;
            this.dataTexture = new THREE.DataTexture(
                this.fb8,
                width,
                height,
                THREE.RGBAFormat,
                THREE.UnsignedByteType,
                THREE.UVMapping,
                THREE.ClampToEdgeWrapping,
                THREE.ClampToEdgeWrapping,
                THREE.LinearFilter,
                THREE.LinearFilter,
                anisotropy,
                THREE.sRGBEncoding
            );
            this.dataTexture.needsUpdate = true;
            this.dataTexture.flipY = true;
            this.dataTexture.repeat.set(1.1, 1.15);
            this.dataTexture.offset.set(-0.03, 0.13);
        }
    }

    class ThreeCanvas {
        constructor(canvas) {
            this.renderer = new THREE.WebGLRenderer({
                alpha: false,
                antialias: true,
                canvas: canvas,
                failIfMajorPerformanceCaveat: true
            });

            try {
                this.renderer.toneMappingExposure = 0.5;
                this.renderer.toneMapping = THREE.ReinhardToneMapping;
                this.renderer.setSize(window.innerWidth, window.innerHeight);
                this.renderer.setPixelRatio(window.devicePixelRatio);
                this.renderer.outputEncoding = THREE.sRGBEncoding;
                this.renderer.shadowMap.enabled = true;
                this.renderer.shadowMap.type = THREE.VSMShadowMap;

                this.scene = new THREE.Scene();
                this.buffer = new FrameBuffer(1024, 1024);
                this.fb32 = new Uint32Array(1024 * 1024);
                this.cpu = null;
                this.beeb = null;
                this.canvas = canvas;

                // Set the background color
                this.scene.background = new THREE.Color('#222222');

                this.renderer.autoClear = false;
                this.renderer.setClearColor(0x000000, 0.0);

                // Create a camera
                const fov = 35;
                const aspectRatio = 640 / 512;
                const near = 0.01;
                const far = 1000;
                this.camera = new THREE.PerspectiveCamera(fov, aspectRatio, near, far);
                this.camera.position.set(0, 20, 36.5);

                this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
                this.controls.target.set(0, 7, -2.36);

                this.scene.add(skyLight());
                const dirLight = directionalLight();
                this.scene.add(dirLight);
                this.scene.add(dirLight.target);

                //Set up shadow properties for the light
                dirLight.shadow.mapSize.width = 512;
                dirLight.shadow.mapSize.height = 512;
                dirLight.shadow.camera.near = -30;
                dirLight.shadow.camera.far = 30;
                dirLight.shadow.camera.left = -30;
                dirLight.shadow.camera.right = 30;
                dirLight.shadow.camera.top = -30;
                dirLight.shadow.camera.bottom = 30;

                dirLight.shadow.radius = 2.0; // blur shadow

                // Other shadow map types might require tweaking these
                //dirLight.shadow.bias = -.01;
                //dirLight.shadow.normalBias = 1.0;

                // uncomment to debug shadow bounds
                //const helper = new THREE.CameraHelper( dirLight.shadow.camera );
                //this.scene.add( helper );

                // Kick off the asynchronous load.
                this.load().then(() => console.log("Three models loaded"));
            } catch (e) {
                this.renderer.dispose();
                throw e;
            }
            $(this.renderer.domElement).remove().appendTo($('#outer'));
            $('#cub-monitor').hide();
            $('#leds').hide();
            console.log("Three Canvas set up");
        }

        setupSceneShadows(object) {
            object.traverse((node) => {
                if (!node.isMesh) return;
                node.castShadow = true;
                node.receiveShadow = true;
            });

        }

        traverseMaterials(object, callback) {
            object.traverse((node) => {
                if (!node.isMesh) return;
                node.castShadow = true;
                node.receiveShadow = true;
                const materials = Array.isArray(node.material) ? node.material : [node.material];
                materials.forEach(callback);
            });
        }

        updateTextureEncoding() {
            const encoding = THREE.sRGBEncoding;

            this.traverseMaterials(this.scene, (material) => {
                if (material.map) material.map.encoding = encoding;
                if (material.emissiveMap) material.emissiveMap.encoding = encoding;
                if (material.map || material.emissiveMap) material.needsUpdate = true;
            });

            this.setupSceneShadows(this.scene);
        }

        async loadBackgroundTexture() {
            return utils.promisifyLoad(new THREE.TextureLoader(), './virtual-beeb/textures/equirectangular-bg.jpg');
        }

        async load() {
            const bgTexture = await this.loadBackgroundTexture();
            const bgTarget = new THREE.WebGLCubeRenderTarget(bgTexture.image.height);
            bgTarget.fromEquirectangularTexture(this.renderer, bgTexture);
            bgTarget.texture.encoding = THREE.sRGBEncoding;
            this.scene.background = bgTarget.texture;
            this.beeb = await loadBeeb(bgTarget.texture, this.buffer.dataTexture);
            if (this.cpu)
                this.beeb.setProcessor(this.cpu);
            this.scene.add(this.beeb.model);
            this.updateTextureEncoding();
            this.keyboardGroup = this.scene.getObjectByName("KeyboardGroup");

            this.clickControls = new ClickControls(this.canvas, this.scene, this.camera, this.controls,this.keyboardGroup);

        }

        frame() {
            this.controls.update();

            if (this.beeb) {
                this.beeb.update(performance.now());
            }

            this.renderer.render(this.scene, this.camera);

            return true;
        }

        setProcessor(cpu) {
            this.cpu = cpu;
            if (this.beeb)
                this.beeb.setProcessor(cpu);
        }

        handleResize(width, height) {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
            return true;
        }

        paint(/*minx, miny, maxx, maxy*/) {
            // Ideally we'd update everything to write to one of two double buffers, but there's too many places in the
            // code that cache the fb32 for now. So just copy it.
            // TODO: fix
            // TODO: subset at least based on miny, maxy?
            this.buffer.fb32.set(this.fb32);
            if (this.beeb) this.beeb.onPaint();
        }
    }

    return ThreeCanvas;
});
