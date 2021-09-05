define(['three', 'jquery', 'three-mtl-loader', 'three-obj-loader', 'three-orbit'], function (THREE, $) {
    "use strict";

    function ThreeCanvas(canvas) {
        const attrs = {
            alpha: false,
            antialias: true,
            canvas: canvas
        };

        this.renderer = new THREE.WebGLRenderer(attrs);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.scene = new THREE.Scene();
        let height = 1024;
        let width = 1024;
        this.fb8 = new Uint8Array(width * height * 4);
        this.fb32 = new Uint32Array(this.fb8.buffer);

        // Set the background color
        this.scene.background = new THREE.Color('#222222');

        // Create a camera
        const fov = 35;
        const near = 0.1;
        const far = 100;
        this.camera = new THREE.PerspectiveCamera(fov, 2, near, far);
        this.camera.position.set(0, 10, 30);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 5, 0);

        {
            const skyColor = 0xB1E1FF;  // light blue
            const groundColor = 0xB97A20;  // brownish orange
            const intensity = 0.8;
            const light = new THREE.HemisphereLight(skyColor, groundColor, intensity);
            this.scene.add(light);
        }

        {
            const color = 0xFFFFFF;
            const intensity = 0.7;
            const light = new THREE.DirectionalLight(color, intensity);
            light.position.set(5, 10, 2);
            this.scene.add(light);
            this.scene.add(light.target);
        }

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
        const material = new THREE.MeshBasicMaterial(
            {
                transparent: true,
                map: this.dataTexture,
                refractionRatio: 0.8
            })


        {
            const mtlLoader = new THREE.MTLLoader();
            mtlLoader.load('./virtual-beeb/models/beeb.mtl', (mtl) => {
                mtl.preload();
                const objLoader = new THREE.OBJLoader();
                //  mtl.materials.Material.side = THREE.DoubleSide;
                objLoader.setMaterials(mtl);
                objLoader.load('./virtual-beeb/models/beeb.obj', (root) => {
                    root.scale.set(50, 50, 50)
                    this.scene.add(root);


                    //  List out all the object names from the import - very useful!
                    this.scene.traverse(function (child) {
                        console.log(child.name);
                    });

                    const screen = this.scene.getObjectByName("SCREEN_SurfPatch.002");
                    screen.material = new THREE.MeshBasicMaterial(
                        {
                            transparent: true,
                            map: this.dataTexture
                        })

                });
            });
        }
        $('#cub-monitor-pic').hide();
        $('#cub-monitor').css({'z-index': 0});
        console.log("Three Canvas set up");
    }

    ThreeCanvas.prototype.paint = function (minx, miny, maxx, maxy) {
        this.dataTexture.needsUpdate = true;
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    };

    return ThreeCanvas;
});