const {createHash}=require('node:crypto');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const TERMINAL=new Set(['cancelada','publicada']);
function identity(type,id){
 if(!['imagen','reel'].includes(type))throw fail('tipo debe ser imagen o reel');
 if(!/^\d+$/.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<1)throw fail('ID inválido');
 return Number(id);
}
async function migrateDeletion(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS media_eliminaciones (
 id BIGSERIAL PRIMARY KEY,tipo TEXT NOT NULL,media_id BIGINT NOT NULL,
 bytes_eliminados BIGINT NOT NULL,estado_revisado TEXT NOT NULL,
 origen TEXT NOT NULL DEFAULT 'user_confirmed_via_action',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}
function createDeletion({pool,publicBaseUrl}){
 const base=publicBaseUrl.replace(/\/$/,'');
 async function inspect(db,type,value){
  const id=identity(type,value),isImage=type==='imagen';
  const sql=isImage?`SELECT id,created_at,purged_at,COALESCE(octet_length(image_data),0)+COALESCE(octet_length(background_data),0) AS bytes FROM imagenes_marketing WHERE id=$1`:
   `SELECT id,created_at,purged_at,status,COALESCE(octet_length(video_data),0) AS bytes FROM reels_marketing WHERE id=$1`;
  const row=(await db.query(sql,[id])).rows[0];if(!row)throw fail('Medio no encontrado',404);
  const url=`${base}/media/${isImage?'generated':'reels'}/${id}.${isImage?'jpg':'mp4'}`;
  const refs=await db.query(`SELECT id,status,revision FROM publicaciones_instagram
   WHERE ${isImage?'image_id':'reel_id'}=$1 OR image_url=$2 ORDER BY id`,[id,url]);
  const scenes=isImage?(await db.query(`SELECT id,status FROM reels_marketing WHERE image_ids @> $1::jsonb AND purged_at IS NULL ORDER BY id`,[JSON.stringify([id])])).rows:[];
  const blockers=refs.rows.filter(x=>!TERMINAL.has(x.status)).map(x=>({tipo:'publicacion',...x}));
  blockers.push(...scenes.map(x=>({tipo:'reel',...x})));
  if(!isImage&&['pendiente','procesando'].includes(row.status))blockers.push({tipo:'montaje',id,status:row.status});
  const fingerprint=createHash('sha256').update(JSON.stringify([type,row,refs.rows,scenes])).digest('hex');
  return {tipo:type,id,archivo_url:Number(row.bytes)>0?url:null,bytes_a_eliminar:Number(row.bytes),
   archivo_eliminado:!!row.purged_at&&Number(row.bytes)===0,puede_eliminar:blockers.length===0,
   bloqueos:blockers,publicaciones:refs.rows,reels:scenes,revision_borrado:fingerprint,
   alcance:'Eliminar bytes del archivo y fondo de PostgreSQL; conservar IDs e historial. No elimina publicaciones de Instagram.'};
 }
 async function preview(type,id){return inspect(pool,type,id);}
 async function remove(type,id,body){
  identity(type,id);
  if(body?.confirmacion!==true||!(/^[a-f0-9]{64}$/.test(body?.revision_borrado||'')))throw fail('Se requiere autorización explícita y revision_borrado de la consulta previa');
  const db=pool.connect?await pool.connect():pool;
  try{
   await db.query('BEGIN');
   // Same lock order as retention; blocks new attachments and worker claims.
   await db.query('LOCK TABLE publicaciones_instagram, imagenes_marketing, reels_marketing IN SHARE ROW EXCLUSIVE MODE');
   const item=await inspect(db,type,id);
   if(item.archivo_eliminado){await db.query('COMMIT');return {tipo:type,id:Number(id),eliminado:true,ya_eliminado:true,bytes_eliminados:0};}
   if(!item.puede_eliminar)throw fail('El archivo está en uso. Consultá los bloqueos; no se canceló ni eliminó ninguna pieza.',409);
   if(item.revision_borrado!==body.revision_borrado)throw fail('El estado cambió. Volvé a consultar antes de eliminar.',409);
   if(type==='imagen')await db.query('UPDATE imagenes_marketing SET image_data=NULL,background_data=NULL,purged_at=NOW() WHERE id=$1',[id]);
   else await db.query("UPDATE reels_marketing SET video_data=NULL,status='eliminada',purged_at=NOW(),updated_at=NOW() WHERE id=$1",[id]);
   await db.query('INSERT INTO media_eliminaciones(tipo,media_id,bytes_eliminados,estado_revisado) VALUES($1,$2,$3,$4)',[type,id,item.bytes_a_eliminar,item.revision_borrado]);
   await db.query('COMMIT');
   return {tipo:type,id:Number(id),eliminado:true,bytes_eliminados:item.bytes_a_eliminar,historial_conservado:true,instagram_modificado:false};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{if(db!==pool)db.release();}
 }
 return {preview,remove};
}
function registerDeletion(app,deps){
 const service=createDeletion(deps);
 const route=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){
  const code=e.status===400?'CONFIRMACION_O_PARAMETROS_INVALIDOS':e.status===409?'MEDIO_EN_USO_O_ESTADO_CAMBIADO':e.status===404?'MEDIO_NO_ENCONTRADO':'ERROR_INTERNO_ELIMINACION';
  console.error(JSON.stringify({event:'media_deletion_error',method:req.method,status:e.status||500,code,db_code:/^[A-Z0-9]{5}$/.test(e.code||'')?e.code:undefined}));
  res.status(e.status||500).json({codigo:code,error:e.status?e.message:'No se pudo completar la eliminación; consultá el estado antes de repetir'});
 }};
 app.get('/api/medios/:tipo/:id/eliminacion',route(req=>service.preview(req.params.tipo,req.params.id)));
 app.post('/api/medios/:tipo/:id/eliminar',route(req=>service.remove(req.params.tipo,req.params.id,req.body)));
 app.delete('/api/medios/:tipo/:id',route(req=>service.remove(req.params.tipo,req.params.id,req.body)));
 return service;
}
module.exports={migrateDeletion,createDeletion,registerDeletion};
