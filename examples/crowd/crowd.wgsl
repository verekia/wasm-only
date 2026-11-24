struct Scene {
  viewProjection: mat4x4f,
  light: vec4f,                 // direction towards the light, world space
}
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<storage, read> matrices: array<mat4x4f>;     // nib/skin's result, as it left it

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) colour: vec3f,
}

@vertex fn vertex(
  @location(0) position: vec3f, @location(1) normal: vec4f, @location(2) colour: vec4f,
  @location(3) joints: vec4u, @location(4) weights: vec4f,
  @location(5) slot: u32, @location(6) tint: vec4f,           // a character: its first matrix, and its tint
) -> Varyings {
  let skin = matrices[slot + joints.x] * weights.x + matrices[slot + joints.y] * weights.y
           + matrices[slot + joints.z] * weights.z + matrices[slot + joints.w] * weights.w;
  return Varyings(scene.viewProjection * (skin * vec4f(position, 1)), (skin * vec4f(normal.xyz, 0)).xyz, colour.rgb * tint.rgb);
}

@fragment fn fragment(v: Varyings) -> @location(0) vec4f {
  let n = normalize(v.normal);
  let albedo = pow(v.colour, vec3f(2.2));
  let lit = albedo * (0.2 + 0.12 * n.z + max(dot(n, scene.light.xyz), 0));
  return vec4f(pow(lit, vec3f(1 / 2.2)), 1);
}
