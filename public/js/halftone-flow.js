/*
 * ThreeUI — PredictiveArcCanvas · variant "halftone-flow"
 * Ported from the canonical source bundle (SHA-256 fa86582fc870):
 *   src/shaders/neuform-isolated/sources/nexus-unified-flow.html
 *   (SHA-256 fa1a015ae407dc2091c3c96239d28107e973cbc03aa7abef37dd5da791d5428b)
 * The authored raw-WebGL halftone flow field (#glcanvas) is reproduced verbatim,
 * with its palette remapped from red-orange to gray/white for this project.
 * It is mounted behind the login screen and only runs while that screen is up.
 */
(function () {
  'use strict';

  const canvas = document.getElementById('glcanvas');
  const loginScreen = document.getElementById('login-screen');
  if (!canvas) return;
  const gl = canvas.getContext('webgl');

  if (!gl) {
    console.error('WebGL not supported');
    return;
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  const vsSource = `
      attribute vec4 aVertexPosition;
      void main() {
          gl_Position = aVertexPosition;
      }
  `;

  const fsSource = `
      precision highp float;
      uniform vec2 u_resolution;
      uniform float u_time;

      mat2 rot(float a) {
          float s = sin(a), c = cos(a);
          return mat2(c, -s, s, c);
      }

      void main() {
          vec2 uv = gl_FragCoord.xy / u_resolution.xy;
          vec2 p = uv * 2.0 - 1.0;
          p.x *= u_resolution.x / u_resolution.y;

          vec2 flow_uv = p;
          float time = u_time * 0.1;

          for(float i = 1.0; i < 4.0; i++) {
              flow_uv *= rot(time * 0.1);
              flow_uv.x += sin(flow_uv.y * 2.0 * i + time) * 0.5;
              flow_uv.y += cos(flow_uv.x * 1.5 * i - time * 0.8) * 0.5;
          }

          float intensity = sin(flow_uv.x * 2.0 + flow_uv.y * 3.0) * 0.5 + 0.5;

          vec3 col_dark = vec3(0.015, 0.015, 0.018);
          vec3 col_red = vec3(0.22, 0.23, 0.26);
          vec3 col_bright = vec3(0.46, 0.47, 0.51);

          vec3 fluid_color = mix(col_dark, col_red, smoothstep(0.2, 0.6, intensity));
          fluid_color = mix(fluid_color, col_bright, smoothstep(0.7, 1.0, intensity));

          float gridSize = 6.0;
          vec2 grid_uv = gl_FragCoord.xy / gridSize;
          vec2 cell_uv = fract(grid_uv) - 0.5;

          float dist = length(cell_uv);
          float radius = intensity * 0.45;
          float dot_mask = smoothstep(radius, radius - 0.1, dist);

          vec3 final_color = mix(vec3(0.0), fluid_color, dot_mask);
          final_color += fluid_color * 0.08;

          gl_FragColor = vec4(final_color, 1.0);
      }
  `;

  function compileShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error(gl.getShaderInfoLog(shader));
          gl.deleteShader(shader);
          return null;
      }
      return shader;
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.useProgram(program);

  const positions = new Float32Array([
      -1.0,  1.0,
       1.0,  1.0,
      -1.0, -1.0,
       1.0, -1.0,
  ]);
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

  const positionLocation = gl.getAttribLocation(program, "aVertexPosition");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
  const timeLocation = gl.getUniformLocation(program, "u_time");

  let startTime = Date.now();
  function render() {
      requestAnimationFrame(render);
      // The authored loop runs only while the login screen is mounted.
      if (!loginScreen || !loginScreen.classList.contains('active')) return;

      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, (Date.now() - startTime) / 1000.0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  render();
})();
