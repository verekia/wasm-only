struct Scene {
  view_projection: mat4x4f,
  light: vec4f,              // direction towards the light
}
@group(0) @binding(0) var<uniform> scene: Scene;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec4f,
}

// One cube mesh, drawn once per instance. An instance is three vec4s written by the game.
@vertex fn vertex(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) place: vec4f,       // xyz: centre, w: turn about the vertical axis, in radians
  @location(3) size: vec4f,        // xyz: half extents
  @location(4) color: vec4f,       // rgb: albedo (sRGB), a: glow
) -> Varyings {
  let c = cos(place.w);
  let s = sin(place.w);
  let turn = mat3x3f(c, 0, -s, 0, 1, 0, s, 0, c);
  let world = turn * (position * size.xyz) + place.xyz;
  return Varyings(scene.view_projection * vec4f(world, 1), turn * normal, color);
}

@fragment fn fragment(v: Varyings) -> @location(0) vec4f {
  let albedo = pow(v.color.rgb, vec3f(2.2));
  let lambert = max(dot(normalize(v.normal), normalize(scene.light.xyz)), 0);
  let lit = albedo * (0.14 + lambert + v.color.a);
  return vec4f(pow(lit, vec3f(1 / 2.2)), 1);
}
