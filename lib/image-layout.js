const sharp = require('sharp');
const escape = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function validateCopy(copy) {
  const result={title:copy.title,subtitle:copy.subtitle??'',bullets:copy.bullets??[],cta:copy.cta??'Pedí información'};
  for (const [name,max] of [['title',180],['subtitle',320],['cta',80]]) {
    if (typeof result[name]!=='string' || result[name].length>max || (name!=='subtitle' && !result[name].trim())) {
      throw Object.assign(new Error(`${name} inválido (máximo ${max} caracteres)`),{status:400});
    }
    result[name]=result[name].trim();
  }
  if (!Array.isArray(result.bullets)||result.bullets.length>4||result.bullets.some(b=>typeof b!=='string'||!b.trim()||b.length>140)) {
    throw Object.assign(new Error('bullets admite hasta 4 textos de 140 caracteres'),{status:400});
  }
  return result;
}
async function renderText(value,size,width,bold=false,color='#14382c') {
  return sharp({text:{text:`<span foreground="${color}">${escape(value)}</span>`,font:`DejaVu Sans ${bold?'Bold ':''}${size}`,width,rgba:true,wrap:'word-char',dpi:72}})
    .png().toBuffer({resolveWithObject:true});
}
async function prepareLayout(copy) {
  copy=validateCopy(copy);
  for (const scale of [1,0.9,0.8,0.7]) {
    const items=[];
    let y=210;
    const add=async(value,size,width,left,bold,gap)=>{
      if (!value) return;
      const r=await renderText(value,Math.round(size*scale),width,bold);
      items.push({input:r.data,left,top:y});
      y+=r.info.height+gap;
    };
    await add(copy.title,52,520,76,true,32);
    await add(copy.subtitle,27,520,76,false,32);
    for(const bullet of copy.bullets) await add(`• ${bullet}`,25,520,76,false,22);
    const cta=await renderText(copy.cta,Math.round(28*scale),472,true,'#ffffff');
    const ctaHeight=Math.max(78,cta.info.height+36);
    const ctaTop=1160-ctaHeight;
    if(y<=ctaTop-28 && ctaHeight<=155) {
      const base=Buffer.from(`<svg width="1024" height="1280" xmlns="http://www.w3.org/2000/svg">
        <rect x="36" y="36" width="610" height="1180" rx="32" fill="#fbfcf8"/>
        <rect x="76" y="82" width="48" height="16" rx="4" fill="#16855e"/>
        <rect x="92" y="66" width="16" height="48" rx="4" fill="#16855e"/>
        <rect x="76" y="${ctaTop}" width="520" height="${ctaHeight}" rx="22" fill="#137b56"/>
      </svg>`);
      const brand=await renderText('SISMED',38,430,true);
      return [{input:base,left:0,top:0},{input:brand.data,left:145,top:70},...items,
        {input:cta.data,left:100,top:ctaTop+Math.floor((ctaHeight-cta.info.height)/2)}];
    }
  }
  throw Object.assign(new Error('El texto no entra de forma legible. Acortá el título, subtítulo o beneficios.'),{status:422});
}
async function applySismedOverlay(buffer,copy) {
  const layout=await prepareLayout(copy);
  return sharp(buffer).resize(1024,1280,{fit:'cover'}).composite(layout)
    .jpeg({quality:94,chromaSubsampling:'4:4:4'}).toBuffer();
}
module.exports={validateCopy,prepareLayout,applySismedOverlay};
