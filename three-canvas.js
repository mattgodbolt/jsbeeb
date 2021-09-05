define(['three', 'jquery', 'three-mtl-loader', 'three-obj-loader', 'three-orbit'], function (THREE, $) {
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
            const height = 1024;
            const width = 1024;
            this.fb8 = new Uint8Array(width * height * 4);
            this.fb32 = new Uint32Array(this.fb8.buffer);

            // Set the background color
            this.scene.background = new THREE.Color('#222222');

            // Create a camera
            const fov = 35;
            const aspectRatio = 640/512;
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
            this.dataTexture.repeat.set(0.42, 0.42);
            this.dataTexture.offset.set(0.3, 0.5);

            this.load();

            $(this.renderer.domElement).remove().appendTo($('#outer'));
            $('#cub-monitor').hide();
            console.log("Three Canvas set up");
        }

        load() {
            const mtlLoader = new THREE.MTLLoader();
            mtlLoader.load('./virtual-beeb/models/beeb.mtl', (mtl) => {
                mtl.preload();
                const objLoader = new THREE.OBJLoader();
                //  mtl.materials.Material.side = THREE.DoubleSide;
                objLoader.setMaterials(mtl);
                objLoader.load('./virtual-beeb/models/beeb.obj', (root) => {
                    root.scale.set(50, 50, 50);
                    this.scene.add(root);

                    //  List out all the object names from the import - very useful!
                    this.scene.traverse(function (child) {
                        console.log(child.name);
                    });

                    const screen = this.scene.getObjectByName("SCREEN_SurfPatch.002");
                    screen.material = new THREE.MeshBasicMaterial(
                        {
                            transparent: false,
                            map: this.dataTexture
                        });

                });
            });
        }

        frame() {
            // TODO once we can keep the complete dataTexture separate (we get flicker with this...)
            // this.controls.update();
            // this.renderer.render(this.scene, this.camera);
        }

        handleResize(width, height) {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
            return true;
        }

        paint(minx, miny, maxx, maxy) {
            this.dataTexture.needsUpdate = true;
            // TODO double buffer texture here? Then frame() draws it
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        }
    }

    return ThreeCanvas;
});