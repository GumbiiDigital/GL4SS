import type { JumpCharacter } from './pin';

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uDir;
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p, float px) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, px), x1 = mod(i.x + 1.0, px);
  return mix(mix(hash(vec2(x0, i.y)), hash(vec2(x1, i.y)), f.x),
             mix(hash(vec2(x0, i.y + 1.0)), hash(vec2(x1, i.y + 1.0)), f.x), f.y);
}
float fbm(vec2 p, float px) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p, px); p *= 2.0; px *= 2.0; a *= 0.5; }
  return v;
}
vec3 tunnel(vec2 uv, float t) {
  float r = length(uv);
  float ang = atan(uv.y, uv.x);
  float depth = 0.40 / (r + 0.06) + t;
  vec2 tc = vec2(ang / 6.28318531, depth);
  float n = fbm(tc * vec2(12.0, 3.0) + vec2(0.0, t * 0.6), 12.0);
  float bands = fbm(tc * vec2(28.0, 1.4) - vec2(0.0, t * 1.3), 28.0);
  float glow = pow(1.0 - clamp(r, 0.0, 1.0), 2.2);
  float energy = n * 0.65 + bands * 0.75;
  vec3 col = mix(uColorA, uColorB, clamp(energy + glow * 0.45, 0.0, 1.0));
  col *= energy * 0.95 + glow * 0.70;
  float streak = pow(abs(sin(ang * 22.0 + n * 7.0)), 14.0);
  col += streak * glow * 0.95 * uColorB;
  return col;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uTime * uDir * (0.30 + uIntensity * 0.85);
  float ab = 0.014 * uIntensity;
  vec3 col = vec3(tunnel(uv * (1.0 - ab), t).r, tunnel(uv, t).g,
                  tunnel(uv * (1.0 + ab), t).b);
  float r = length(uv);
  col *= smoothstep(0.09, 0.42, r);
  col *= 1.0 - smoothstep(0.55, 1.08, r);
  float sy = gl_FragCoord.y / uRes.y;
  col *= smoothstep(0.0, 0.30, sy);
  col *= 1.0 - 0.55 * smoothstep(0.72, 1.0, sy);
  col *= uIntensity;
  float lum = max(col.r, max(col.g, col.b));
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), clamp(lum, 0.0, 1.0) * 0.62);
}
`;

const PALETTE: Record<JumpCharacter['direction'], [number[], number[]]> = {
  forward: [[0.05, 0.32, 0.85], [0.55, 0.95, 1]],
  back: [[0.55, 0.14, 0.02], [1, 0.78, 0.35]],
};

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL could not create a shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Warp shader failed';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

export interface WarpRenderer {
  render: (timeSeconds: number, jump: JumpCharacter) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
}

/** Create the shared warp pipeline. The caller owns timing and dimensions. */
export function createWarpRenderer(canvas: HTMLCanvasElement): WarpRenderer | null {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl || gl.isContextLost()) return null;

  let vertex: WebGLShader;
  let fragment: WebGLShader;
  try {
    vertex = compile(gl, gl.VERTEX_SHADER, VERT);
    fragment = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  } catch (error) {
    console.warn('[looking-glass] warp shader failed:', error);
    return null;
  }

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  gl.useProgram(program);
  gl.disable(gl.BLEND);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const resolution = gl.getUniformLocation(program, 'uRes');
  const time = gl.getUniformLocation(program, 'uTime');
  const direction = gl.getUniformLocation(program, 'uDir');
  const intensity = gl.getUniformLocation(program, 'uIntensity');
  const colorA = gl.getUniformLocation(program, 'uColorA');
  const colorB = gl.getUniformLocation(program, 'uColorB');

  return {
    resize(width, height) {
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    render(timeSeconds, jump) {
      const [a, b] = PALETTE[jump.direction];
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, timeSeconds);
      gl.uniform1f(direction, jump.direction === 'forward' ? 1 : -1);
      gl.uniform1f(intensity, jump.reach === 'far' ? 1 : 0.58);
      gl.uniform3f(colorA, a[0]!, a[1]!, a[2]!);
      gl.uniform3f(colorB, b[0]!, b[1]!, b[2]!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteBuffer(buffer);
      if (!canvas.isConnected) gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
