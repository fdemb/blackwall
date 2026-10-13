INSERT INTO users(id,email,password_hash,profile) VALUES
('10000000-0000-0000-0000-000000000001','empty@example.com','__FIXTURE_PASSWORD_HASH__','{"id":"10000000-0000-0000-0000-000000000001","email":"empty@example.com","display_name":"Empty owner","avatar_url":null,"contact":"","language":"en","theme":"system","alerts":{"assignments":true,"replies":true,"changes":true,"deadlines":true}}');
INSERT INTO workspaces(id,name,slug) VALUES('10000000-0000-0000-0000-000000000010','Empty workspace','empty-workspace');
INSERT INTO workspace_members(workspace_id,user_id,role) VALUES('10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001','owner');
