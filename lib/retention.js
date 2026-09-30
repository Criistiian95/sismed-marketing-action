// Retain metadata and remove bytes only after every reference has a confirmed,
// seven-day-old publication. All related writes wait for this short transaction.
async function cleanup(pool){
 const client=pool.connect?await pool.connect():pool;
 try{
  await client.query('BEGIN');
  await client.query('LOCK TABLE publicaciones_instagram, imagenes_marketing, reels_marketing IN SHARE ROW EXCLUSIVE MODE');
  const gate=await client.query(`UPDATE mantenimiento_media SET ultima_limpieza=NOW() WHERE id=1 AND (ultima_limpieza IS NULL OR ultima_limpieza<NOW()-INTERVAL '1 day') RETURNING id`);
  if(!gate.rows.length){await client.query('COMMIT');return {imagenes:0,reels:0};}
  const reels=await client.query(`UPDATE reels_marketing r SET video_data=NULL,purged_at=NOW()
   WHERE video_data IS NOT NULL AND EXISTS(SELECT 1 FROM publicaciones_instagram p WHERE p.reel_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM publicaciones_instagram p WHERE p.reel_id=r.id AND
    (p.status<>'publicada' OR COALESCE(p.published_at,p.verified_at,NOW())>NOW()-INTERVAL '7 days')) RETURNING id`);
  const images=await client.query(`UPDATE imagenes_marketing i SET image_data=NULL,background_data=NULL,purged_at=NOW()
   WHERE image_data IS NOT NULL
   AND (EXISTS(SELECT 1 FROM publicaciones_instagram p WHERE p.image_id=i.id)
    OR EXISTS(SELECT 1 FROM reels_marketing r WHERE r.image_ids @> jsonb_build_array(i.id) AND r.purged_at IS NOT NULL))
   AND NOT EXISTS(SELECT 1 FROM publicaciones_instagram p WHERE (p.image_id=i.id OR p.image_url LIKE '%/media/generated/'||i.id||'.jpg') AND
    (p.status<>'publicada' OR COALESCE(p.published_at,p.verified_at,NOW())>NOW()-INTERVAL '7 days'))
   AND NOT EXISTS(SELECT 1 FROM reels_marketing r WHERE r.image_ids @> jsonb_build_array(i.id) AND r.purged_at IS NULL)
   RETURNING id`);
  await client.query('COMMIT');return {imagenes:images.rows.length,reels:reels.rows.length};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{if(client!==pool)client.release();}
}
module.exports={cleanup};
