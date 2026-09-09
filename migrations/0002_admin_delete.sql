-- IDs prevent a delayed upload retry from restoring an intentionally deleted photo.
CREATE TABLE deleted_uploads (id TEXT PRIMARY KEY);
CREATE TABLE deletion_jobs (id TEXT PRIMARY KEY);
CREATE TRIGGER photo_removed AFTER DELETE ON photos BEGIN
 INSERT OR IGNORE INTO deleted_uploads(id) VALUES(OLD.id);
 INSERT OR IGNORE INTO deletion_jobs(id) VALUES(OLD.id);
 DELETE FROM uploads WHERE id=OLD.id;
 UPDATE totals SET total=total-1, bytes=bytes-OLD.size, revision=revision+1,
 institutions=institutions-(SELECT CASE WHEN files=1 THEN 1 ELSE 0 END FROM institutions WHERE name=OLD.nickname) WHERE id=1;
 UPDATE institutions SET files=files-1 WHERE name=OLD.nickname;
 DELETE FROM institutions WHERE name=OLD.nickname AND files=0;
END;
