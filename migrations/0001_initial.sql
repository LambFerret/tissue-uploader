CREATE TABLE uploads (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, nickname TEXT NOT NULL, name TEXT NOT NULL,
 size INTEGER NOT NULL, thumb_size INTEGER NOT NULL, crc32 INTEGER NOT NULL, format TEXT NOT NULL,
 created TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX uploads_pending ON uploads(status,created);
CREATE TABLE photos (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, nickname TEXT NOT NULL, name TEXT NOT NULL,
 size INTEGER NOT NULL, thumb_size INTEGER NOT NULL, crc32 INTEGER NOT NULL, created TEXT NOT NULL, format TEXT NOT NULL
);
CREATE INDEX photos_created ON photos(created,id);
CREATE INDEX photos_owner_created ON photos(owner,created,id);
CREATE INDEX photos_institution_created ON photos(nickname COLLATE NOCASE,created,id);
CREATE TABLE objects (key TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size>=0));
CREATE TABLE totals (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL DEFAULT 0, institutions INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, r2_bytes INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO totals(id) VALUES(1);
CREATE TABLE institutions (name TEXT PRIMARY KEY, files INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER photo_added AFTER INSERT ON photos BEGIN
 INSERT INTO institutions(name,files) VALUES(NEW.nickname,1) ON CONFLICT(name) DO UPDATE SET files=files+1;
 UPDATE totals SET total=total+1, bytes=bytes+NEW.size, revision=revision+1,
 institutions=institutions+(SELECT CASE WHEN files=1 THEN 1 ELSE 0 END FROM institutions WHERE name=NEW.nickname) WHERE id=1;
END;
CREATE TRIGGER object_added AFTER INSERT ON objects BEGIN
 UPDATE totals SET r2_bytes=r2_bytes+NEW.size WHERE id=1;
END;
CREATE TRIGGER object_removed AFTER DELETE ON objects BEGIN
 UPDATE totals SET r2_bytes=r2_bytes-OLD.size WHERE id=1;
END;
CREATE TABLE sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE list_cache (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE analytics_cache (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated INTEGER NOT NULL, error TEXT);
