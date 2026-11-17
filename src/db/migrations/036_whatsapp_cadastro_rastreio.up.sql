ALTER TABLE admtaxi.usuarios ADD COLUMN app_instalado_em TIMESTAMPTZ;
ALTER TABLE admtaxi.usuarios ADD COLUMN whatsapp_autorizado_em TIMESTAMPTZ;

UPDATE admtaxi.usuarios u SET app_instalado_em=d.instalado_em FROM (
 SELECT usuario_id,MIN(criado_em) AS instalado_em FROM admtaxi.dispositivos_usuario
 WHERE modo_acesso='PWA' OR (plataforma='ANDROID' AND navegador='Android WebView (APK)')
 GROUP BY usuario_id
) d WHERE u.id=d.usuario_id;

CREATE FUNCTION admtaxi.registrar_app_instalado() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.modo_acesso='PWA' OR (NEW.plataforma='ANDROID' AND NEW.navegador='Android WebView (APK)') THEN
   UPDATE admtaxi.usuarios SET app_instalado_em=COALESCE(app_instalado_em,CURRENT_TIMESTAMP)
     WHERE empresa_id=NEW.empresa_id AND id=NEW.usuario_id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER registrar_app_instalado AFTER INSERT OR UPDATE ON admtaxi.dispositivos_usuario
 FOR EACH ROW EXECUTE PROCEDURE admtaxi.registrar_app_instalado();

CREATE TABLE admtaxi.whatsapp_cadastros (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 empresa_id UUID NOT NULL,
 usuario_id UUID NOT NULL,
 autorizado_por UUID NOT NULL,
 telefone_hash TEXT NOT NULL CHECK (telefone_hash ~ '^[a-f0-9]{64}$'),
 status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN
  ('PENDENTE','ENVIANDO','ACEITO','ENVIADO','ENTREGUE','LIDO','FALHOU','INCERTO','IGNORADO')),
 tentativas INTEGER NOT NULL DEFAULT 0,
 mensagem_id TEXT UNIQUE,
 criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 tentar_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(empresa_id,usuario_id),
 FOREIGN KEY(empresa_id,usuario_id) REFERENCES admtaxi.usuarios(empresa_id,id),
 FOREIGN KEY(empresa_id,autorizado_por) REFERENCES admtaxi.usuarios(empresa_id,id)
);
CREATE INDEX whatsapp_cadastros_pendentes ON admtaxi.whatsapp_cadastros(tentar_em,id) WHERE status='PENDENTE';

CREATE TABLE admtaxi.rastreios_passageiro (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 empresa_id UUID NOT NULL,
 corrida_id UUID NOT NULL,
 funcionario_id UUID NOT NULL,
 token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expira_em TIMESTAMPTZ NOT NULL,
 revogado_em TIMESTAMPTZ,
 FOREIGN KEY(empresa_id,corrida_id,funcionario_id)
   REFERENCES admtaxi.corrida_participacoes(empresa_id,corrida_id,funcionario_id),
 CHECK(expira_em>criado_em)
);
CREATE INDEX rastreios_passageiro_corrida ON admtaxi.rastreios_passageiro(empresa_id,corrida_id,funcionario_id);
