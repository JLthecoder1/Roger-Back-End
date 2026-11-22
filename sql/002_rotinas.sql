CREATE TABLE IF NOT EXISTS roger.operadores (
 nome text PRIMARY KEY,
 perfil text NOT NULL CHECK (perfil IN ('supervisor','rondista'))
);
INSERT INTO roger.operadores(nome,perfil) VALUES
 ('Victor','supervisor'),('Ewerton','rondista'),('Marcos','rondista')
ON CONFLICT (nome) DO NOTHING;

ALTER TABLE roger.checkpoints ADD COLUMN IF NOT EXISTS assigned_to text REFERENCES roger.operadores(nome);
ALTER TABLE roger.voice_sessions ADD COLUMN IF NOT EXISTS officer text REFERENCES roger.operadores(nome);
