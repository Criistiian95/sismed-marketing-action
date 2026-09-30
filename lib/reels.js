const {spawn}=require('node:child_process');
const {mkdtemp,writeFile,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
async function migrateMedia(pool){
 const statements=`ALTER TABLE imagenes_marketing ALTER COLUMN image_data DROP NOT NULL,
 ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
 CREATE TABLE IF NOT EXISTS reels_marketing (
 id BIGSERIAL PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
 image_ids JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pendiente',video_data BYTEA,
 error TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),purged_at TIMESTAMPTZ);
 ALTER TABLE publicaciones_instagram ADD COLUMN IF NOT EXISTS reel_id BIGINT REFERENCES reels_marketing(id);
 CREATE TABLE IF NOT EXISTS mantenimiento_media(id INTEGER PRIMARY KEY, ultima_limpieza TIMESTAMPTZ);
 INSERT INTO mantenimiento_media(id) VALUES(1) ON CONFLICT DO NOTHING;`;
 for(const sql of statements.split(";").filter(x=>x.trim()))await pool.query(sql);
 await pool.query(`CREATE OR REPLACE FUNCTION validar_media_publicacion() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.image_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.image_id IS DISTINCT FROM OLD.image_id) THEN
 PERFORM id FROM imagenes_marketing WHERE id=NEW.image_id AND image_data IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Imagen archivada o inexistente'; END IF;
 END IF;
 IF NEW.reel_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.reel_id IS DISTINCT FROM OLD.reel_id) THEN
 PERFORM id FROM reels_marketing WHERE id=NEW.reel_id AND video_data IS NOT NULL AND status='lista' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reel archivado o inexistente'; END IF;
 END IF;
 RETURN NEW; END $$`);
 await pool.query('DROP TRIGGER IF EXISTS comprobar_media ON publicaciones_instagram');
 await pool.query('CREATE TRIGGER comprobar_media BEFORE INSERT OR UPDATE OF image_id,reel_id ON publicaciones_instagram FOR EACH ROW EXECUTE FUNCTION validar_media_publicacion()');
 await pool.query(`CREATE OR REPLACE FUNCTION validar_escenas_reel() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE scene JSONB;
 BEGIN
 FOR scene IN SELECT value FROM jsonb_array_elements(NEW.image_ids) LOOP
 PERFORM id FROM imagenes_marketing WHERE id=(scene::text)::bigint AND image_data IS NOT NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Escena archivada o inexistente'; END IF;
 END LOOP; RETURN NEW; END $$`);
 await pool.query('DROP TRIGGER IF EXISTS comprobar_escenas ON reels_marketing');
 await pool.query('CREATE TRIGGER comprobar_escenas BEFORE INSERT ON reels_marketing FOR EACH ROW EXECUTE FUNCTION validar_escenas_reel()');
}
function validate(body){
 if(!/^[a-zA-Z0-9_-]{16,100}$/.test(body.request_id||''))throw fail('request_id inválido');
 if(!Array.isArray(body.image_ids)||body.image_ids.length<3||body.image_ids.length>5||body.image_ids.some(x=>!Number.isSafeInteger(x)||x<1))throw fail('Elegí entre 3 y 5 image_ids válidos; cada escena dura 5 segundos');
 return body.image_ids;
}
function run(args){return new Promise((resolve,reject)=>{
 const child=spawn(process.env.FFMPEG_PATH||require('ffmpeg-static'),args,{stdio:['ignore','ignore','ignore']});
 const timer=setTimeout(()=>{child.kill('SIGKILL');reject(fail('El montaje excedió el tiempo permitido',503));},180000);
 child.once('error',e=>{clearTimeout(timer);reject(e);});
 child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(fail('No se pudo montar el video',503));});
});}
async function render(images){
 const dir=await mkdtemp(join(tmpdir(),'sismed-reel-'));
 try{
  const args=['-y','-threads','1','-filter_complex_threads','1'];
  for(let i=0;i<images.length;i++){
   // Preserve every word of the existing 4:5 artwork inside a 9:16 canvas.
   const frame=await sharp(images[i]).resize(720,1280,{fit:'contain',background:'#e9f4ee'}).png().toBuffer();
   const file=join(dir,`${i}.png`);await writeFile(file,frame);args.push('-loop','1','-t','5','-i',file);
  }
  const filters=images.map((_,i)=>`[${i}:v]fps=24,format=yuv420p,fade=t=in:st=0:d=0.25,fade=t=out:st=4.75:d=0.25[v${i}]`).join(';')+';'+images.map((_,i)=>`[v${i}]`).join('')+`concat=n=${images.length}:v=1:a=0[out]`;
  const output=join(dir,'reel.mp4');
  await run([...args,'-filter_complex',filters,'-map','[out]','-c:v','libx264','-threads','1','-preset','veryfast','-crf','27','-movflags','+faststart','-an',output]);
  const data=await readFile(output);if(data.length>12*1024*1024)throw fail('Video demasiado grande',422);return data;
 }finally{await rm(dir,{recursive:true,force:true});}
}
function createReels({pool,publicBaseUrl,renderer=render}){
 const base=publicBaseUrl.replace(/\/$/,'');let busy=false;
 function present(row){const {video_data,...rest}=row;return {...rest,video_url:row.status==='lista'&&!row.purged_at?`${base}/media/reels/${row.id}.mp4`:null,duracion_segundos:row.image_ids.length*5};}
 async function get(id){if(!/^\d+$/.test(String(id)))throw fail('ID inválido');const r=await pool.query('SELECT id,request_id,image_ids,status,error,created_at,purged_at FROM reels_marketing WHERE id=$1',[id]);if(!r.rows.length)throw fail('Reel no encontrado',404);return present(r.rows[0]);}
 async function create(body){const ids=validate(body),hash=createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  const existing=await pool.query('SELECT * FROM reels_marketing WHERE request_id=$1',[body.request_id]);
  if(existing.rows.length){if(existing.rows[0].request_hash!==hash)throw fail('request_id usado para otro reel',409);return present(existing.rows[0]);}
  const found=await pool.query('SELECT id FROM imagenes_marketing WHERE id=ANY($1::bigint[]) AND image_data IS NOT NULL',[ids]);
  if(new Set(ids).size!==found.rows.length)throw fail('Hay imágenes inexistentes o archivadas',409);
  const r=await pool.query(`INSERT INTO reels_marketing(request_id,request_hash,image_ids) VALUES($1,$2,$3)
   ON CONFLICT(request_id) DO NOTHING RETURNING *`,[body.request_id,hash,JSON.stringify(ids)]);
  if(!r.rows.length)return create(body);return present(r.rows[0]);
 }
 async function process(){if(busy)return;busy=true;
  try{
   await pool.query(`UPDATE reels_marketing SET status='error',error='Montaje interrumpido; revisar',updated_at=NOW() WHERE status='procesando' AND updated_at<NOW()-INTERVAL '10 minutes'`);
   const claim=await pool.query(`UPDATE reels_marketing SET status='procesando',updated_at=NOW() WHERE id=(SELECT id FROM reels_marketing WHERE status='pendiente' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
   if(!claim.rows.length)return;const item=claim.rows[0];
   try{const r=await pool.query('SELECT id,image_data FROM imagenes_marketing WHERE id=ANY($1::bigint[])',[item.image_ids]);const imgs=item.image_ids.map(id=>r.rows.find(x=>Number(x.id)===id)?.image_data);if(imgs.some(x=>!x))throw fail('Falta una escena');const data=await renderer(imgs);
    await pool.query(`UPDATE reels_marketing SET video_data=$2,status='lista',updated_at=NOW() WHERE id=$1 AND status='procesando'`,[item.id,data]);
   }catch(_){await pool.query(`UPDATE reels_marketing SET status='error',error='No se completó el montaje. Revisar antes de repetir.',updated_at=NOW() WHERE id=$1`,[item.id]);}
  }finally{busy=false;}
 }
 return {create,get,process};
}
module.exports={migrateMedia,createReels,render,validate};
