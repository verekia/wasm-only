struct Uniforms {
  mvp: mat4x4f,     // clip from model
  model: mat4x4f,   // world from model: a pure rotation, so it also transforms normals
  light: vec4f,     // direction towards the light, world space
  color: vec4f,     // albedo, sRGB
}
@group(0) @binding(0) var<uniform> u: Uniforms;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
}

@vertex fn vertex(@location(0) position: vec3f, @location(1) normal: vec3f) -> Varyings {
  return Varyings(u.mvp * vec4f(position, 1), (u.model * vec4f(normal, 0)).xyz);
}

@fragment fn fragment(v: Varyings) -> @location(0) vec4f {
  let albedo = pow(u.color.rgb, vec3f(2.2));
  let lambert = max(dot(normalize(v.normal), u.light.xyz), 0);
  let lit = albedo * (0.06 + lambert);
  return vec4f(pow(lit, vec3f(1 / 2.2)), 1);
}
