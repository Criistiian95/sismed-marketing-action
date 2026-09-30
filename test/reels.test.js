const {test}=require('node:test');const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');const sharp=require('sharp');
const {migrateMedia,createReels,render}=require('../lib/reels');
const {migrate,createPublications}=require('../lib/publications');const {cleanup}=require('../lib/retention');
test('montaje MP4 real, aprobación, publicación y retención de referencias compartidas',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE imagenes_marketing(id BIGSERIAL PRIMARY KEY,image_data BYTEA NOT NULL,background_data BYTEA);
 CREATE TABLE publicaciones_instagram(id BIGSERIAL PRIMARY KEY,image_url TEXT NOT NULL,caption TEXT NOT NULL DEFAULT '',scheduled_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'programada',instagram_media_id TEXT,error TEXT,published_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());`);
 await migrate(db);await migrateMedia(db);await migrateMedia(db);
 const image=await sharp({create:{width:720,height:900,channels:3,background:'#168060'}}).jpeg().toBuffer();
 for(let i=0;i<3;i++)await db.query('INSERT INTO imagenes_marketing(image_data,background_data) VALUES($1,$1)',[image]);
 const videos=createReels({pool:db,publicBaseUrl:'https://test.example'});
 const body={request_id:'reel-test-request-001',image_ids:[1,2,3]};
 const v=await videos.create(body);assert.equal(v.status,'pendiente');assert.equal((await videos.create(body)).id,v.id);
 await assert.rejects(videos.create({...body,image_ids:[3,2,1]}),{status:409});
 await videos.process();const ready=await videos.get(v.id);assert.equal(ready.status,'lista');assert.match(ready.video_url,/mp4$/);
 const bytes=(await db.query('SELECT video_data FROM reels_marketing')).rows[0].video_data;assert.equal(Buffer.from(bytes).subarray(4,8).toString(),'ftyp');
 let calls=[];const pubs=createPublications({pool:db,accountId:'test',publicBaseUrl:'https://test.example',wait:async()=>{},igRequest:async(path,opts)=>{calls.push(opts);return path.endsWith('media_publish')?{id:'published'}:path.endsWith('media')?{id:'container'}:{status_code:'FINISHED'};}});
 const draft=await pubs.createReel({reel_id:Number(v.id),request_id:'reel-draft-request-1',caption:'Prueba'});
 await assert.rejects(pubs.publish(draft.id,1),{status:409});await pubs.approve(draft.id,{revision:1,confirmacion:true});await pubs.publish(draft.id,1);
 assert.equal(calls[0].params.media_type,'REELS');assert.equal(calls[0].params.video_url,ready.video_url);
 const pending=await pubs.create({image_id:1,request_id:'image-draft-request1',caption:'Pendiente'});
 await db.query(`UPDATE publicaciones_instagram SET published_at=NOW()-INTERVAL '8 days' WHERE id=$1`,[draft.id]);
 const removed=await cleanup(db);assert.equal(removed.reels,1);assert.equal(removed.imagenes,2);
 assert.ok((await db.query('SELECT image_data FROM imagenes_marketing WHERE id=1')).rows[0].image_data);
 assert.equal((await pubs.get(pending.id)).status,'borrador');assert.equal((await pubs.get(draft.id)).instagram_media_id,'published');
 assert.equal((await videos.get(v.id)).video_url,null);
 await assert.rejects(pubs.createReel({reel_id:Number(v.id),request_id:'new-reel-draft-001'}),{status:409});
 }finally{await db.close();}
});
