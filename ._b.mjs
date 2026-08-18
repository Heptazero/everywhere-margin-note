import * as esbuild from "esbuild"; import path from "node:path";
const stub={name:"s",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"o",namespace:"s"}));
b.onLoad({filter:/.*/,namespace:"s"},()=>({contents:`export class TFile{}`,loader:"js"}));}};
await esbuild.build({entryPoints:[path.resolve("src/pdf/quote-anchor.ts")],bundle:true,format:"esm",
 platform:"node",outfile:path.join(process.env.OUT,"qa.mjs"),plugins:[stub]});
console.log("built");
