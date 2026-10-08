// WebGL2 compositor for the preview. Draws each layer with the same parameters the export uses
// (shared/evaluate.ts): transform, opacity, color LUT, vignette, blur, RGB shift, dip colour, noise.
import type { LayerState } from '../../shared/evaluate';
import { LUT_SIZE } from '../../shared/color';
import { MASK_KIND_ID } from '../../shared/transitions';

const VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCanvas;   // project size in px
uniform vec2 uCenter;   // px
uniform vec2 uSize;     // px
uniform float uRot;     // radians
out vec2 vUv;
void main() {
  vUv = aPos + 0.5;
  vec2 p = aPos * uSize;
  float c = cos(uRot), s = sin(uRot);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) + uCenter;
  vec2 ndc = vec2(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uTex;
uniform sampler3D uLut;
uniform bool uUseLut;
uniform float uOpacity;
uniform float uBlur;      // sigma in uv units (x)
uniform float uBlurAspect;// content h/w to convert sigma for y
uniform bool uBlurH;
uniform float uShift;     // uv units
uniform vec3 uDipColor;
uniform float uDip;
uniform float uNoise;
uniform float uSeed;
uniform float uVignette;  // angle
uniform vec2 uContentSize;
uniform float uLutN;
uniform vec4 uFill[4];
uniform int uFillN;
uniform int uMaskKind;    // 0 none, 1 linear, 2 circle, 3 diamond, 4 clock, 5 bands (shared/transitions.ts)
uniform float uMaskP;
uniform float uMaskAngle; // radians
uniform float uMaskF;
uniform float uMaskBands;
uniform vec2 uLayerPx;    // layer size in px
in vec2 vUv;
out vec4 outColor;

vec4 src(vec2 uv) {
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  // HUD clean-up: inside a fill box, interpolate from the box borders (like FFmpeg's delogo)
  for (int i = 0; i < 4; i++) {
    if (i >= uFillN) break;
    vec4 b = uFill[i];
    if (uv.x > b.x && uv.x < b.x + b.z && uv.y > b.y && uv.y < b.y + b.w) {
      vec2 e = 1.5 / uContentSize;
      vec4 l = texture(uTex, vec2(b.x - e.x, uv.y));
      vec4 r = texture(uTex, vec2(b.x + b.z + e.x, uv.y));
      vec4 t = texture(uTex, vec2(uv.x, b.y - e.y));
      vec4 d = texture(uTex, vec2(uv.x, b.y + b.w + e.y));
      float wl = 1.0 / (uv.x - b.x + e.x), wr = 1.0 / (b.x + b.z - uv.x + e.x);
      float wt = 1.0 / (uv.y - b.y + e.y), wd = 1.0 / (b.y + b.w - uv.y + e.y);
      return (l * wl + r * wr + t * wt + d * wd) / (wl + wr + wt + wd);
    }
  }
  return texture(uTex, uv);
}

vec4 grade(vec2 uv) {
  vec4 c = src(uv);
  if (uUseLut) {
    vec3 coord = clamp(c.rgb, 0.0, 1.0) * ((uLutN - 1.0) / uLutN) + 0.5 / uLutN;
    c.rgb = texture(uLut, coord).rgb;
  }
  if (uVignette > 0.0) {
    vec2 d = (uv - 0.5) * uContentSize;
    float dn = length(d) / length(uContentSize * 0.5);
    float f = cos(min(uVignette * dn, 1.5707963));
    f = f * f; f = f * f;
    c.rgb *= f;
  }
  return c;
}

vec4 blurred(vec2 uv) {
  if (uBlur <= 0.0001) return grade(uv);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  if (uBlurH) {
    for (int i = -12; i <= 12; i++) {
      float x = float(i) / 12.0 * 2.5 * uBlur;
      float w = exp(-0.5 * pow(float(i) / 12.0 * 2.5, 2.0));
      acc += grade(uv + vec2(x, 0.0)) * w;
      wsum += w;
    }
  } else {
    // Vogel-spiral disk sampling
    for (int i = 0; i < 32; i++) {
      float r = sqrt((float(i) + 0.5) / 32.0) * 2.5;
      float a = float(i) * 2.39996323;
      vec2 o = vec2(cos(a), sin(a)) * r * vec2(uBlur, uBlur / uBlurAspect);
      float w = exp(-0.5 * r * r);
      acc += grade(uv + o) * w;
      wsum += w;
    }
  }
  return acc / wsum;
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + uSeed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Mirrors maskDistance()/maskValue() in shared/transitions.ts and the geq expression in the export.
float maskValue(vec2 uv) {
  if (uMaskKind == 0) return 1.0;
  vec2 px = uv * uLayerPx;
  float d;
  if (uMaskKind == 1) {
    float c = cos(uMaskAngle), s = sin(uMaskAngle);
    float r = 0.5 * (abs(c) + abs(s));
    d = ((uv.x - 0.5) * c + (uv.y - 0.5) * s + r) / (2.0 * r);
  } else if (uMaskKind == 2) {
    d = length(px - uLayerPx * 0.5) / (0.5 * length(uLayerPx));
  } else if (uMaskKind == 3) {
    d = abs(uv.x - 0.5) + abs(uv.y - 0.5);
  } else if (uMaskKind == 4) {
    d = mod(atan(px.x - uLayerPx.x * 0.5, uLayerPx.y * 0.5 - px.y) / 6.2831853 + 1.0, 1.0);
  } else {
    float q = (abs(uMaskAngle - 1.5707963) < 0.01 ? uv.y : uv.x) * uMaskBands;
    d = fract(q);
  }
  float f = max(1e-4, uMaskF);
  float e = -f + uMaskP * (1.0 + 2.0 * f);
  return clamp((e - d) / f, 0.0, 1.0);
}

void main() {
  vec2 uv = vUv; // y grows downward, texture row 0 = top
  vec4 c;
  if (uShift > 0.0) {
    vec4 base = blurred(uv);
    float r = blurred(uv - vec2(uShift, 0.0)).r;
    float b = blurred(uv + vec2(uShift, 0.0)).b;
    c = vec4(r, base.g, b, base.a);
  } else {
    c = blurred(uv);
  }
  if (uNoise > 0.0) {
    float n = hash(uv * uContentSize) - 0.5;
    c.rgb += n * 0.22;
  }
  c.rgb = mix(c.rgb, uDipColor, uDip);
  float a = c.a * uOpacity * maskValue(uv);
  outColor = vec4(clamp(c.rgb, 0.0, 1.0) * a, a);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(uColor.rgb * uColor.a, uColor.a); }`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

export type TexSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

export interface DrawParams {
  layer: LayerState;
  source: TexSource;
  sourceKey: string;
  contentW: number;
  contentH: number;
  lut: Float32Array | null;
  lutKey: string;
  vignette: number; // angle
  seed: number;
  /** HUD fill boxes, normalized x,y,w,h (max 4) */
  fill?: { x: number; y: number; w: number; h: number }[];
}

export class GLCompositor {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private solid: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private textures = new Map<string, { tex: WebGLTexture; used: number }>();
  private luts = new Map<string, { tex: WebGLTexture; used: number }>();
  private frameNo = 0;
  private dummyLut: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private us: Record<string, WebGLUniformLocation | null> = {};
  projectW = 1920;
  projectH = 1080;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available on this computer (update your graphics driver).');
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.solid = program(gl, VS, SOLID_FS);
    for (const n of ['uCanvas', 'uCenter', 'uSize', 'uRot', 'uTex', 'uLut', 'uUseLut', 'uOpacity', 'uBlur', 'uBlurAspect', 'uBlurH', 'uShift', 'uDipColor', 'uDip', 'uNoise', 'uSeed', 'uVignette', 'uContentSize', 'uLutN', 'uFill', 'uFillN', 'uMaskKind', 'uMaskP', 'uMaskAngle', 'uMaskF', 'uMaskBands', 'uLayerPx'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    for (const n of ['uCanvas', 'uCenter', 'uSize', 'uRot', 'uColor']) this.us[n] = gl.getUniformLocation(this.solid, n);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.dummyLut = this.makeLutTex(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]), 2);
  }

  private makeLutTex(data: Float32Array, size: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    return t;
  }

  begin(bg: [number, number, number]): void {
    const gl = this.gl;
    this.frameNo++;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
  }

  /** Upload (or reuse) a texture for a source. `dynamic` sources (video) are re-uploaded every draw. */
  private texture(key: string, src: TexSource, dynamic: boolean): WebGLTexture {
    const gl = this.gl;
    let e = this.textures.get(key);
    if (!e) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e = { tex, used: 0 };
      this.textures.set(key, e);
      dynamic = true;
    }
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    if (dynamic) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    }
    e.used = this.frameNo;
    return e.tex;
  }

  invalidateTexture(key: string): void {
    const e = this.textures.get(key);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.textures.delete(key);
    }
  }

  private lutTex(key: string, data: Float32Array): WebGLTexture {
    let e = this.luts.get(key);
    if (!e) {
      e = { tex: this.makeLutTex(data, LUT_SIZE), used: 0 };
      this.luts.set(key, e);
    }
    e.used = this.frameNo;
    return e.tex;
  }

  draw(d: DrawParams, dynamic: boolean): void {
    const gl = this.gl;
    const L = d.layer;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    this.texture(d.sourceKey, d.source, dynamic);
    gl.uniform1i(this.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    if (d.lut) gl.bindTexture(gl.TEXTURE_3D, this.lutTex(d.lutKey, d.lut));
    else gl.bindTexture(gl.TEXTURE_3D, this.dummyLut);
    gl.uniform1i(this.u.uLut, 1);
    gl.uniform1i(this.u.uUseLut, d.lut ? 1 : 0);
    gl.uniform1f(this.u.uLutN, LUT_SIZE);
    gl.uniform2f(this.u.uCanvas, this.projectW, this.projectH);
    gl.uniform2f(this.u.uCenter, L.cx, L.cy);
    gl.uniform2f(this.u.uSize, L.w, L.h);
    gl.uniform1f(this.u.uRot, (L.rotation * Math.PI) / 180);
    gl.uniform1f(this.u.uOpacity, L.opacity);
    gl.uniform1f(this.u.uBlur, L.blur > 0 ? L.blur / Math.max(1, L.w) : 0);
    gl.uniform1f(this.u.uBlurAspect, L.h / Math.max(1, L.w));
    gl.uniform1i(this.u.uBlurH, L.blurHorizontalOnly ? 1 : 0);
    gl.uniform1f(this.u.uShift, L.rgbShift > 0 ? L.rgbShift / Math.max(1, L.w) : 0);
    gl.uniform3f(this.u.uDipColor, L.dipColor[0], L.dipColor[1], L.dipColor[2]);
    gl.uniform1f(this.u.uDip, L.dipAmount);
    gl.uniform1f(this.u.uNoise, L.noise > 0.01 ? 1 : 0);
    gl.uniform1f(this.u.uSeed, d.seed);
    gl.uniform1f(this.u.uVignette, d.vignette);
    gl.uniform2f(this.u.uContentSize, d.contentW, d.contentH);
    const fill = (d.fill ?? []).slice(0, 4);
    const fa = new Float32Array(16);
    fill.forEach((b, i) => fa.set([b.x, b.y, b.w, b.h], i * 4));
    gl.uniform4fv(this.u.uFill, fa);
    gl.uniform1i(this.u.uFillN, fill.length);
    const mk = L.mask;
    gl.uniform1i(this.u.uMaskKind, mk ? MASK_KIND_ID[mk.kind] : 0);
    gl.uniform1f(this.u.uMaskP, mk ? mk.p : 1);
    gl.uniform1f(this.u.uMaskAngle, mk ? (mk.angle * Math.PI) / 180 : 0);
    gl.uniform1f(this.u.uMaskF, mk ? mk.feather : 0.01);
    gl.uniform1f(this.u.uMaskBands, mk ? mk.bands : 1);
    gl.uniform2f(this.u.uLayerPx, Math.max(1, L.w), Math.max(1, L.h));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  rect(x: number, y: number, w: number, h: number, rgba: [number, number, number, number]): void {
    const gl = this.gl;
    gl.useProgram(this.solid);
    gl.uniform2f(this.us.uCanvas, this.projectW, this.projectH);
    gl.uniform2f(this.us.uCenter, x + w / 2, y + h / 2);
    gl.uniform2f(this.us.uSize, w, h);
    gl.uniform1f(this.us.uRot, 0);
    gl.uniform4f(this.us.uColor, rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Free textures that have not been used for a while. */
  gc(maxAgeFrames = 600): void {
    for (const [k, e] of this.textures) if (this.frameNo - e.used > maxAgeFrames) this.invalidateTexture(k);
    for (const [k, e] of this.luts)
      if (this.frameNo - e.used > maxAgeFrames) {
        this.gl.deleteTexture(e.tex);
        this.luts.delete(k);
      }
  }
}
