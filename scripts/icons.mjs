import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
function crc32(b) { let c = -1; for (const v of b) { c ^= v; for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0); } return (c^-1)>>>0; }
function chunk(type, bytes) { const data=Buffer.concat([Buffer.from(type),bytes]); const out=Buffer.alloc(data.length+8); out.writeUInt32BE(bytes.length); data.copy(out,4); out.writeUInt32BE(crc32(data),out.length-4); return out; }
export function icons(dir) {
  fs.mkdirSync(dir,{recursive:true});
  for (const n of [16,32,48,128]) {
    const bytes=Buffer.alloc(n*(1+n*4));
    for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
      const u=(x+.5)/n,v=(y+.5)/n;
      const inside=u>.08&&u<.92&&v>.08&&v<.92;
      const box=u>.22&&u<.78&&v>.4&&v<.77;
      const handle=u>.36&&u<.64&&v>.25&&v<.44&&!(u>.42&&u<.58&&v>.31);
      const color=(box||handle)&&!(box&&v>.52&&v<.57)?[197,255,220]:[29,61,48];
      const i=y*(1+n*4)+1+x*4; for(let c=0;c<3;c++)bytes[i+c]=color[c];bytes[i+3]=inside?255:0;
    }
    const h=Buffer.alloc(13);h.writeUInt32BE(n);h.writeUInt32BE(n,4);h[8]=8;h[9]=6;
    fs.writeFileSync(path.join(dir,`${n}.png`),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]));
  }
}
