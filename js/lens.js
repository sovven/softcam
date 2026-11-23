export const FILTERS = [
  { id: 'none', name: '无', sw: 'linear-gradient(135deg,#e8e4dc,#a9b0b6)', p: {} },
  { id: 'soft', name: 'Soft', sw: 'linear-gradient(135deg,#ffffff,#f3ece2)', p: { expo: .3785, contrast: .05, sat: -.2, hard: 1, blur: .12 } },
  { id: 'cream', name: '奶白', sw: 'linear-gradient(135deg,#fff8ec,#f1dcc6)', p: { expo: .2, shadows: .3, highlights: -.3, contrast: -.04, sat: -.1, temp: .02, tint: .01, glow: .35 } },
  { id: 'pale', name: '冷白', sw: 'linear-gradient(135deg,#fbf7fc,#d9d8ee)', p: { expo: .2, shadows: .4, highlights: -.15, contrast: .05, sat: -.06, vib: .1, temp: -.07, tint: .03, glow: .25 } },
  { id: 'honey', name: '蜜糖', sw: 'linear-gradient(135deg,#fff3cf,#e9c27e)', p: { expo: .12, shadows: .2, contrast: .06, sat: -.04, temp: .07, tint: .015, hr: .012, hg: .006, hb: -.02, glow: .2 } },
  { id: 'mono', name: '黑白', sw: 'linear-gradient(135deg,#f4f4f4,#3c3c3c)', p: { expo: .05, contrast: .14, sat: -1, grain: .03, vig: .16 } }
];

export const MODELS = [
  { id: 'raw', name: '原相机', short: '原相机', front: 0, rear: 0, p: {} },
  { id: 'ip4', name: 'iPhone 4', short: '4', front: 640, rear: 2592, mp: ['0.3MP', '5MP'], jpg: .82, p: { temp: .045, tint: -.018, contrast: .12, sat: -.1, shadows: -.08, hard: 1, sharp: .4, grain: .035, cnoise: .6, vig: .22, hr: .01, hg: .012, hb: -.02 } },
  { id: 'ip5s', name: 'iPhone 5s', short: '5s', front: 1280, rear: 3264, mp: ['1.2MP', '8MP'], jpg: .85, p: { temp: .05, tint: .012, contrast: -.02, sat: -.05, nr: .5, hard: 1, sharp: .25, grain: .02, cnoise: .3, sr: .012, sb: .02, vig: .1 } },
  { id: 'ip6', name: 'iPhone 6', short: '6', front: 1280, rear: 3264, mp: ['1.2MP', '8MP'], jpg: .86, p: { temp: .03, tint: .006, contrast: .04, sat: .02, nr: .35, hard: 1, sharp: .3, grain: .018, glow: .15, vig: .08 } },
  { id: 'ip8', name: 'iPhone 8', short: '8', front: 3088, rear: 4032, mp: ['7MP', '12MP'], jpg: .9, p: { temp: .02, contrast: .1, sat: .1, vib: .1, sharp: .45, hard: .7, highlights: -.05 } },
  { id: 'ipxr', name: 'iPhone XR', short: 'XR', front: 3088, rear: 4032, mp: ['7MP', '12MP'], jpg: .92, p: { temp: .035, tint: .005, shadows: .25, highlights: -.25, contrast: .04, sat: .06, nr: .2, skin: .3, sharp: .2 } }
];

const VS = `attribute vec2 a;varying vec2 v;void main(){v=a*.5+.5;gl_Position=vec4(a,0.,1.);}`;
const FS = `precision highp float;
varying vec2 v;uniform sampler2D tex;uniform vec2 px;uniform vec4 rect;uniform float mir,sasp,time,osz;
uniform vec2 fc[6];uniform vec2 fp[36];uniform float fr[6],fw[6];uniform float slim;
uniform float expo,contrast,sat,vib,temp,tint,shadows,highlights,glow,grain,cnoise,vig,sr,sg,sb,hr,hg,hb,hard,blur,sharp,nr,skin;
uniform float ublur,unoise,ev,flash;uniform vec2 fpos,opx;
float hash(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
void main(){
  vec2 o2=vec2(mir>.5?1.-v.x:v.x,v.y);
  vec2 uv=rect.xy+o2*rect.zw;
  if(slim>0.){vec2 off=vec2(0.);for(int j=0;j<6;j++){if(fw[j]>0.){for(int i=0;i<6;i++){vec2 q0=fp[j*6+i];vec2 d=(uv-q0)*vec2(sasp,1.);float q=dot(d,d)/(fr[j]*fr[j]);if(q<1.){float w=1.-q;off+=(fc[j]-q0)*slim*fw[j]*w*w;}}}}uv-=off;}
  vec3 col=texture2D(tex,uv).rgb;
  float sc=rect.w;
  vec2 ar=vec2(1./sasp,1.);
  float br=(.0035+.035*ublur+.006*blur)*sc;
  vec3 bs=col,pb=col,wide=col;float ws=1.;
  for(int i=0;i<16;i++){
    float fi=float(i),an=fi*2.39996,r=sqrt((fi+.5)/16.);
    vec2 o=vec2(cos(an),sin(an))*r*ar;
    vec3 s=texture2D(tex,uv+o*.007*sc).rgb;
    vec3 d=s-col;float w=exp(-dot(d,d)*70.);bs+=s*w;ws+=w;
    pb+=texture2D(tex,uv+o*br).rgb;
    wide+=texture2D(tex,uv+o*.07*sc).rgb;
  }
  bs/=ws;pb/=17.;wide/=17.;
  if(sharp>0.){
    vec2 e=vec2(opx.x*1.6,0.);vec2 f=vec2(0.,opx.y*1.6);
    vec3 sm=(texture2D(tex,uv+e).rgb+texture2D(tex,uv-e).rgb+texture2D(tex,uv+f).rgb+texture2D(tex,uv-f).rgb)*.25;
    col+=(col-sm)*sharp*1.6;
  }
  float cb=-.169*col.r-.331*col.g+.5*col.b,cr=.5*col.r-.419*col.g-.081*col.b;
  float sk=smoothstep(.0,.035,cr)*(1.-smoothstep(.14,.2,cr))*(1.-smoothstep(-.02,.02,cb))*smoothstep(-.22,-.16,cb);
  col=mix(col,bs,clamp(nr+skin*sk,0.,1.));
  col=mix(col,pb,clamp(blur+ublur*1.2,0.,1.));
  col*=vec3(1.+temp,1.-tint,1.-temp);
  float fl=0.;
  if(flash>0.){vec2 dd=v-fpos;fl=exp(-dot(dd,dd)/.11);col*=mix(1.-.32*flash,1.+1.5*flash,fl);col*=vec3(1.-.02*flash,1.,1.+.03*flash);}
  col*=pow(2.,expo+ev);
  float l=luma(col);
  col*=1.+shadows*pow(1.-clamp(l,0.,1.),3.)*1.4+highlights*pow(clamp(l,0.,1.),3.)*.6;
  col=(col-.5)*(1.+contrast)+.5;
  l=luma(col);
  float mx=max(col.r,max(col.g,col.b)),mn=min(col.r,min(col.g,col.b));
  col=mix(vec3(l),col,max(0.,1.+sat+vib*(1.-clamp((mx-mn)*2.2,0.,1.))));
  float lc=clamp(l,0.,1.);
  col+=vec3(sr,sg,sb)*(1.-lc)*(1.-lc)*3.+vec3(hr,hg,hb)*lc*lc*3.;
  float wl=luma(wide)*pow(2.,expo+ev);
  col+=wide*pow(clamp((wl-.5)/.5,0.,1.),1.6)*(glow*.42+ublur*.1);
  vec3 t=max(col-.8,0.)/.2;col=mix(min(col,.8)+.2*t/(1.+t),clamp(col,0.,1.),clamp(hard,0.,1.));
  col*=1.-vig*smoothstep(.35,.95,length(v-.5)*1.25);
  float g=grain+unoise*.15;
  if(g>0.){
    float gs=max(1.,osz/1000.)*(1.+unoise*.7);
    vec2 gp=floor(gl_FragCoord.xy/gs)+floor(time*24.)*17.;
    float n=hash(gp)-.5;
    vec3 cn=vec3(hash(gp+3.1),hash(gp+7.3),hash(gp+11.7))-.5;
    col+=(n+cn*(cnoise+unoise*.5))*g*(1.25-lc*.7);
  }
  gl_FragColor=vec4(clamp(col,0.,1.),1.);
}`;

const GRADE = ['expo', 'contrast', 'sat', 'vib', 'temp', 'tint', 'shadows', 'highlights', 'glow', 'grain', 'cnoise', 'vig', 'sr', 'sg', 'sb', 'hr', 'hg', 'hb', 'hard', 'blur', 'sharp', 'nr', 'skin'];

export function mixParams(o) {
  const m = (MODELS.find(x => x.id === o.model) || MODELS[0]).p;
  const f = (FILTERS.find(x => x.id === o.filter) || FILTERS[0]).p;
  const k = o.strength ?? 1, out = {};
  for (const g of GRADE) out[g] = (m[g] || 0) + (f[g] || 0) * k;
  out.hard = Math.max(m.hard || 0, (f.hard || 0) * k);
  return out;
}

export function createLens(canvas, { preserve = false } = {}) {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: preserve, antialias: false, alpha: false });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const loc = {}, U = n => loc[n] ??= gl.getUniformLocation(pr, n);
  const cur = Object.fromEntries(GRADE.map(k => [k, 0]));
  let lastT = 0, amt = 0;
  const FC = new Float32Array(12), FR = new Float32Array(6), FW = new Float32Array(6), FP = new Float32Array(72);
  return {
    canvas, gl,
    render(src, sw, sh_, o) {
      if (!sw || !sh_) return;
      const W = o.width, H = o.height;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src); } catch { return; }
      const target = mixParams(o);
      const time = o.time ?? performance.now() / 1000;
      const dt = o.instant ? 1 : lastT ? Math.min(.2, Math.max(0, time - lastT)) : 1; lastT = time;
      const ease = o.instant ? 1 : 1 - Math.exp(-dt / .05);
      for (const k of GRADE) { cur[k] += (target[k] - cur[k]) * ease; gl.uniform1f(U(k), cur[k]); }
      const outAsp = W / H, srcAsp = sw / sh_;
      let cw = 1, ch = 1;
      if (srcAsp > outAsp) cw = outAsp / srcAsp; else ch = srcAsp / outAsp;
      const z = Math.max(1, o.zoom || 1); cw /= z; ch /= z;
      gl.uniform4f(U('rect'), (1 - cw) / 2, (1 - ch) / 2, cw, ch);
      gl.uniform2f(U('opx'), cw / W, ch / H);
      gl.uniform2f(U('px'), 1 / sw, 1 / sh_); gl.uniform1f(U('sasp'), srcAsp);
      gl.uniform1f(U('mir'), o.mirror ? 1 : 0); gl.uniform1f(U('time'), time % 1000); gl.uniform1f(U('osz'), W);
      gl.uniform1f(U('ublur'), o.blur || 0); gl.uniform1f(U('unoise'), o.noise || 0); gl.uniform1f(U('ev'), o.ev || 0);
      gl.uniform1f(U('flash'), o.flash || 0); gl.uniform2f(U('fpos'), o.fpos?.[0] ?? .5, o.fpos?.[1] ?? .58);
      const want = o.slim > 0 ? o.slim : 0;
      amt = o.instant ? want : amt + (want - amt) * (1 - Math.exp(-dt / .06));
      const faces = (o.faces || []).slice(0, 6);
      if (faces.length && amt > .004) {
        FW.fill(0);
        faces.forEach((t, j) => { FC[j * 2] = t.c[0]; FC[j * 2 + 1] = t.c[1]; FR[j] = t.r || .01; FW[j] = t.w ?? 1; FP.set(t.p, j * 12); });
        gl.uniform1f(U('slim'), amt * .05); gl.uniform2fv(U('fc[0]'), FC); gl.uniform1fv(U('fr[0]'), FR); gl.uniform1fv(U('fw[0]'), FW); gl.uniform2fv(U('fp[0]'), FP);
      } else gl.uniform1f(U('slim'), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}
