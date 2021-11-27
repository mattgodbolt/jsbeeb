define(['three', 'jquery', 'utils', 'scene/beeb', 'three-mtl-loader', 'three-obj-loader', 'three-orbit'], function (THREE, $, utils, loadBeeb) {
  "use strict";

  function skyLight() {
    const skyColor = 0xeeeeff;
    const intensity = 0.3;
    return new THREE.AmbientLight(skyColor, intensity);
  }

  function directionalLight() {
    const color = 0xFFFFFF;
    const intensity = 2;
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(0.5, 0.5, 1);
    return light;
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
      this.dataTexture.repeat.set(0.75, 0.75);
      this.dataTexture.offset.set(0.15, 0.3);
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
        this.renderer.toneMappingExposure =0.1//THREE.ACESFilmicToneMapping;
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio( window.devicePixelRatio );
        this.renderer.outputEncoding = 3001 // sRGBEncoding
        this.scene = new THREE.Scene();
        this.buffer = new FrameBuffer(1024, 1024);
        this.fb32 = new Uint32Array(1024 * 1024);
        this.cpu = null;
        this.beeb = null;
        //this.renderer.outputEncoding = sRGBEncoding

        // Set the background color
        this.scene.background = new THREE.Color('#222222');

        this.renderer.autoClear = false;
        this.renderer.setClearColor(0x000000, 0.0);

        // Create a camera
        const fov = 60;
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

        // Kick off the asynchronous load.
        this.load().then(() => console.log("Three models loaded"));
      } catch (e) {
        this.renderer.dispose();
        throw e;
      }
      $(this.renderer.domElement).remove().appendTo($('#outer'));
      $('#cub-monitor').hide();
      console.log("Three Canvas set up");
    }

    traverseMaterials (object, callback) {
      object.traverse((node) => {
        if (!node.isMesh) return;
        const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];
        materials.forEach(callback);
      });
    }

    updateTextureEncoding () {
      const encoding = sRGBEncoding

      this.traverseMaterials(this.scene, (material) => {
        if (material.map) material.map.encoding = encoding;
        if (material.emissiveMap) material.emissiveMap.encoding = encoding;
        if (material.map || material.emissiveMap) material.needsUpdate = true;
      });
    }

    async loadBackgroundTexture() {
      return utils.promisifyLoad(new THREE.TextureLoader(), './virtual-beeb/textures/equirectangular-bg.jpg');
    }

    async load() {
      const bgTexture = await this.loadBackgroundTexture();
      const bgTarget = new THREE.WebGLCubeRenderTarget(bgTexture.image.height);
      bgTarget.fromEquirectangularTexture(this.renderer, bgTexture);
      this.scene.background = bgTarget.texture;
      this.beeb = await loadBeeb(bgTarget.texture, this.buffer.dataTexture);
      this.scene.add(this.beeb.model);
      updateTextureEncoding();
    }

    frame() {
      this.controls.update();

      if (this.beeb) {
        this.beeb.update(this.cpu, performance.now());
      }

      this.renderer.render(this.scene, this.camera);

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
