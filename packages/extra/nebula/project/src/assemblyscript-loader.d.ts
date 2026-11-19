declare module "@assemblyscript/loader" {
  export function instantiateStreaming(source: Promise<Response>, imports?: any): Promise<{exports:any}>;
}
