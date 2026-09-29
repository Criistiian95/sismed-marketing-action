const {test}=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {prepareLayout,applySismedOverlay,validateCopy}=require('../lib/image-layout');
test('renderiza tildes, símbolos y CTA extenso sin exceder el lienzo',async()=>{
  const copy={title:'Organizá los turnos de tu consultorio',subtitle:'Gestión de pacientes y profesionales: <sin complicaciones> & más claridad.',
    bullets:['Agenda e historia clínica','Prueba piloto de 3 días'],cta:'Escribinos para pedir información sobre Sismed'};
  const layers=await prepareLayout(copy);
  for(const layer of layers){const m=await sharp(layer.input).metadata();assert.ok(layer.left+m.width<=1024);assert.ok(layer.top+m.height<=1280);}
  const bg=await sharp({create:{width:1024,height:1280,channels:3,background:'#d6e9e0'}}).png().toBuffer();
  const result=await applySismedOverlay(bg,copy);const meta=await sharp(result).metadata();
  assert.equal(meta.width,1024);assert.equal(meta.height,1280);assert.equal(meta.format,'jpeg');
});
test('rechaza sobrecarga de texto sin truncar silenciosamente',async()=>{
  const copy={title:'W'.repeat(180),subtitle:'W'.repeat(320),bullets:Array(4).fill('W'.repeat(140)),cta:'W'.repeat(80)};
  await assert.rejects(prepareLayout(copy),{status:422});
  assert.throws(()=>validateCopy({...copy,title:'x'.repeat(181)}),{status:400});
});
