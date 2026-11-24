// import shader from './scene.wgsl' with { type: 'text' }
declare module '*.wgsl' {
  const text: string
  export default text
}
declare module '*.txt' {
  const text: string
  export default text
}
