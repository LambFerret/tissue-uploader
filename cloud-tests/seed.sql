-- Local test metadata only. No patient data and no large R2 objects are created.
WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<49999)
INSERT INTO photos(id,owner,nickname,name,size,thumb_size,crc32,created,format)
SELECT printf('10000000-0000-4000-8000-%012d',x),'scale-owner',printf('규모검증-%03d치과',x%100),'scale.jpg',1900000,100,0,
strftime('%Y-%m-%dT%H:%M:%fZ','2020-01-01','+'||x||' minutes'),'jpeg' FROM n;
