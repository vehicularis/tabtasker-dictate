// The orb's glass, as TabTasker Business draws its agents' orb (apps/web/src/components/agents/glassAvatar.ts),
// without the portrait: a rim lit from above and below, a highlight, and a wave that follows the voice. Drawn
// in WebGL onto a transparent canvas over the orb's smoked body; `flatWave` is the same wave in 2D for a
// browser that refuses another context.

const vertex = 'attribute vec2 position; varying vec2 uv; void main(){ uv=position; gl_Position=vec4(position,0.,1.); }';
const fragment = `
  precision highp float;
  varying vec2 uv;
  uniform float time;
  uniform float energy;
  uniform float waveOpacity;
  uniform float thickness;
  uniform vec3 background;
  uniform vec3 accent;
  float gaussian(float x, float w) { return exp(-x*x/w); }
  void over(inout vec3 color, inout float opacity, vec3 tint, float alpha) {
    color = color*(1.0-alpha)+tint*alpha;
    opacity = opacity*(1.0-alpha)+alpha;
  }
  void main() {
    vec2 q = uv / .82;
    float radius = length(q);
    float body = 1.0-smoothstep(-.016,.016,radius-1.0);
    if (body<.001) { gl_FragColor=vec4(0.0); return; }
    float dark = 1.0-smoothstep(.15,.6,background.r);
    vec3 glass = vec3(0.0);
    float glassAlpha = 0.0;
    vec2 direction = normalize(q+vec2(.00001));
    float lower = pow(max(0.0,dot(direction,normalize(vec2(.6,-.8)))),5.0);
    float upper = pow(max(0.0,dot(direction,normalize(vec2(-.65,.76)))),6.0);
    vec3 rim = mix(mix(vec3(.35,.42,.50),vec3(.65,.76,.87),dark),vec3(.98,.99,1.0),upper);
    over(glass,glassAlpha,rim,gaussian(radius-.94,.0012)*(.07+.40*upper+.16*lower));
    over(glass,glassAlpha,mix(accent,vec3(.85,.92,1.0),.55),gaussian(radius-.88,.0006)*lower*.14);
    vec2 h = q-vec2(-.36,.48);
    vec2 reflection = vec2(h.x*.84+h.y*.54,-h.x*.54+h.y*.84);
    float highlight = exp(-pow(reflection.x/.080,6.0)-pow(reflection.y/.20,6.0));
    over(glass,glassAlpha,vec3(1.0),highlight*.88);
    float pulse = .5 + .32*sin(time*1.9) + .18*sin(time*3.1+.7);
    float amplitude = (.10 + .23*pulse)*energy;
    float envelope = exp(-q.x*q.x/.48);
    float wave = sin(q.x*10.0-time*2.8) + .24*sin(q.x*19.0-time*3.7);
    float curve = -.09 + amplitude*wave*envelope;
    float d = q.y-curve;
    float internal = (1.0-smoothstep(.76,.91,radius))*envelope*waveOpacity;
    float strength = .60 + .40*energy;
    float core = gaussian(d,.00045*thickness);
    float halo = gaussian(d,.006*thickness);
    float alpha = min(1.0,(core*.98+halo*.10)*internal*strength);
    vec3 color = mix(accent,vec3(1.0),core*.60*dark);
    over(glass,glassAlpha,color,alpha);
    gl_FragColor = vec4(glass*body,body*glassAlpha);
  }`;

export type Glass = {
  /// `background` is the page behind the orb (its red channel decides light or dark glass), `energy` the
  /// wave's strength, `wave` 0 hides the wave while something else is drawn inside the glass.
  draw(time: number, background: number[], energy: number, thickness: number, wave: number): void;
  dispose(): void;
};

const rgb = (hex: string) => (hex.replace('#', '').match(/../g) ?? ['3b', '82', 'f6']).map(value => parseInt(value, 16) / 255);

export function createGlass(canvas: HTMLCanvasElement, accent: string): Glass {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) throw new Error('WebGL unavailable');
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const dispose = () => {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    shaders.forEach(shader => gl.deleteShader(shader));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
  try {
    if (!program || !buffer) throw new Error('Graphics allocation failed');
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Shader allocation failed');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader linking failed');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uniforms = { time: uniform('time'), energy: uniform('energy'), waveOpacity: uniform('waveOpacity'), background: uniform('background'), thickness: uniform('thickness') };
    gl.uniform3fv(uniform('accent'), rgb(accent));
    return {
      draw(time, background, energy, thickness, wave) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform1f(uniforms.time, time);
        gl.uniform1f(uniforms.energy, energy);
        gl.uniform1f(uniforms.thickness, thickness);
        gl.uniform1f(uniforms.waveOpacity, wave);
        gl.uniform3fv(uniforms.background, background);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

/// Without WebGL the orb still shows its wave, drawn flat with the shader's own curve.
export function flatWave(canvas: HTMLCanvasElement, accent: string): Glass {
  const context = canvas.getContext('2d');
  return {
    draw(time, _background, energy, _thickness, wave) {
      if (!context) return;
      const { width, height } = canvas, r = width * .41, cx = width / 2, cy = height / 2;
      context.clearRect(0, 0, width, height);
      if (!wave) return;
      const pulse = .5 + .32 * Math.sin(time * 1.9) + .18 * Math.sin(time * 3.1 + .7);
      const amplitude = (.10 + .23 * pulse) * energy * r;
      context.beginPath();
      for (let x = -r * .9; x <= r * .9; x += 1) {
        const q = x / r, envelope = Math.exp(-q * q / .48);
        const y = cy + .09 * r - amplitude * (Math.sin(q * 10 - time * 2.8) + .24 * Math.sin(q * 19 - time * 3.7)) * envelope;
        if (x === -r * .9) context.moveTo(cx + x, y); else context.lineTo(cx + x, y);
      }
      context.strokeStyle = accent; context.lineWidth = width / 28; context.lineCap = 'round';
      context.stroke();
    },
    dispose() {},
  };
}

/// What shows inside the glass: level bars while you talk, or, while you dictate, your words being written
/// with a text cursor after them (`text`, the part written so far): the line ends at the cursor a little right
/// of the middle and runs out of the glass on the left under a fade. With nothing written yet the cursor
/// stands alone in the middle, rising and falling with your voice. Like the Mac's it blinks from full once
/// the writing has been still for `quiet` ms.
export function paintInside(canvas: HTMLCanvasElement, kind: 'bars' | 'caret' | null, energy: number, time: number, quiet: number, ink: string, text = '') {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  context.fillStyle = ink;
  if (kind === 'caret') {
    const thin = Math.max(1.5, width * .024), blinking = quiet - 600, size = height * .155;
    const words = text.trimStart();
    const x = words ? width * .64 : width / 2;
    if (words) {
      const r = width * .41; // the glass (createGlass)
      context.save();
      context.beginPath(); context.arc(width / 2, height / 2, r * .94, 0, 2 * Math.PI); context.clip();
      context.font = `500 ${size}px "Source Sans 3", system-ui, sans-serif`;
      context.textAlign = 'right'; context.textBaseline = 'middle';
      context.fillText(words.slice(-48), x - thin * 2.2, height / 2 + size * .06);
      // The start of the line fades out where it leaves the glass.
      const fade = context.createLinearGradient(width / 2 - r, 0, width / 2 - r * .15, 0);
      fade.addColorStop(0, 'rgb(0 0 0)'); fade.addColorStop(1, 'rgb(0 0 0 / 0)');
      context.globalCompositeOperation = 'destination-out';
      context.fillStyle = fade; context.fillRect(0, 0, width / 2, height);
      context.restore();
      context.fillStyle = ink;
    }
    const tall = words ? size * (1.15 + .3 * energy) : height * (.14 + .2 * energy);
    context.globalAlpha = blinking < 0 ? 1 : Math.min(1, Math.max(0, .5 + Math.cos(blinking / 1060 * 2 * Math.PI) * 1.2));
    context.beginPath();
    context.roundRect(x - thin / 2, height / 2 - tall / 2, thin, tall, thin / 2);
    context.fill();
    context.globalAlpha = 1;
    return;
  }
  if (kind !== 'bars') return;
  const count = 5, bar = width * .062, gap = width * .05, tallest = height * .4;
  for (let i = 0; i < count; i++) {
    const sway = .5 + .5 * Math.sin(time * 7 + i * 1.7);
    const tall = tallest * (.16 + .84 * energy * (.35 + .65 * sway));
    const x = width / 2 + (i - (count - 1) / 2) * (bar + gap) - bar / 2;
    context.beginPath();
    context.roundRect(x, height / 2 - tall / 2, bar, tall, bar / 2);
    context.fill();
  }
}
