# Banco de dados do TuningStudio

Estrutura inicial em PostgreSQL para contas, perfis, carros, projetos de preparacao, modificacoes, modelos 3D salvos, anuncios de pecas e auditoria.

## Subir app, API e banco localmente

1. Instale Docker Desktop.
2. Copie `.env.example` para `.env` e substitua as tres senhas por segredos longos, aleatorios e diferentes. Nao compartilhe nem envie o `.env` ao Git.
3. No terminal, dentro desta pasta, execute `docker compose up -d --build`.
4. Abra `http://localhost:3000` para acessar cadastro e login. A caixa de e-mail de testes fica em `http://localhost:8025`.
5. Verifique os servicos com `docker compose ps` e veja os logs com `docker compose logs api` ou `docker compose logs db`.

O PostgreSQL, a API e a caixa de e-mail de testes ficam acessiveis apenas pela maquina local (`127.0.0.1`). Um servico de migracao aplica as alteracoes do schema e cria/atualiza um usuario PostgreSQL separado, sem privilegios administrativos, para a API. A API serve tambem os arquivos HTML; abra pelo endereco local, nao por `file://`.

## API disponivel

Todas as respostas de erro usam JSON `{ "error": "..." }`. IDs sao UUIDs. As rotas privadas usam cookie de sessao `HttpOnly`, `SameSite=Strict`; nao guarde senha ou sessao em `localStorage`.

| Metodo | Caminho | Acesso | Funcao |
| --- | --- | --- | --- |
| GET | `/api/health` | Publico | Verifica API e banco |
| POST | `/api/auth/register` | Publico | Cria conta e inicia sessao |
| POST | `/api/auth/login` | Publico | Inicia sessao |
| POST | `/api/auth/forgot-password` | Publico | Envia link temporario de redefinicao |
| POST | `/api/auth/reset-password` | Publico | Define senha nova usando o token enviado |
| POST | `/api/auth/logout` | Sessao | Encerra sessao |
| GET | `/api/auth/me` | Sessao | Retorna o perfil atual |
| GET, POST | `/api/vehicles` | Sessao | Lista ou cadastra carros do usuario |
| DELETE | `/api/vehicles/:id` | Sessao | Remove logicamente um carro proprio |
| GET, POST | `/api/projects` | Sessao | Lista ou salva projetos do usuario |
| DELETE | `/api/projects/:id` | Sessao | Remove logicamente um projeto proprio |

Cadastro e recuperacao de senha estao disponiveis na propria tela de login. Para redefinir a senha localmente, solicite o link e abra a mensagem em `http://localhost:8025`. O token expira em 30 minutos; ao trocar a senha, todas as sessoes existentes sao encerradas. Cadastro exige senha entre 12 e 128 caracteres.

## Tabelas

- `users` e `user_profiles`: identidade, hash de senha e dados opcionais do perfil.
- `vehicles`: veiculos pertencentes a usuarios.
- `projects` e `project_modifications`: configuracoes e pecas instaladas/planejadas.
- `saved_3d_models`: referencias a modelos externos, sem guardar tokens do Sketchfab.
- `parts_listings` e `listing_images`: catalogo/anuncios e chaves de imagens em armazenamento externo.
- `audit_events`: trilha de eventos administrativos e de seguranca; nao grave senhas, tokens ou dados de pagamento nela.

## Seguranca antes de conectar o app

- O dashboard de login, cadastro, recuperacao de senha e rotas de carros/projetos estao conectados. A tela da oficina 3D ainda guarda os projetos no IndexedDB/localStorage; sincronizacao dela com a API ainda precisa ser implementada.
- Nunca conecte o browser diretamente ao PostgreSQL nem coloque credenciais do banco em HTML/JavaScript. A API usa consultas parametrizadas e valida os campos recebidos.
- Senhas sao armazenadas como hash `scrypt` com salt aleatorio, nunca em texto puro. Para politica corporativa, considere migrar para Argon2id.
- A API usa um usuario PostgreSQL separado, sem permissao de criar bancos/roles ou alterar schema. Mantenha a conta administrativa apenas para migracoes e backups.
- O Compose e para desenvolvimento local. Antes de publicar na internet, configure HTTPS, dominio/origem confiavel, backups automaticos e monitoramento, revise limites de requisicao e politica de privacidade.
- O Mailpit captura e-mails apenas para testes locais; nao entrega mensagens reais. Em producao, configure um SMTP confiavel e use `PUBLIC_APP_URL` com HTTPS para compor links de recuperacao validos.
- Mantenha `.env` fora do Git, restrinja acesso a backups e rotacione credenciais se forem expostas. O `.gitignore` desta pasta ja exclui `.env` e dumps comuns.
- Oculte/exclua dados pessoais conforme a politica do produto e requisitos aplicaveis; evite guardar placa/VIN completos sem necessidade. Os campos de identificacao de veiculo aqui guardam somente os ultimos caracteres.
- Aplique migracoes novas de forma versionada; a migracao inicial automatica so e executada quando o volume PostgreSQL e criado pela primeira vez.

## Comandos uteis

- Parar sem apagar os dados: `docker compose down`
- Fazer backup local: `docker compose exec -T db pg_dump -U "$env:POSTGRES_USER" "$env:POSTGRES_DB" > backup.sql`
- Restaurar backups requer planejamento e validacao; mantenha copias criptografadas fora da maquina.

Nao execute `docker compose down -v` se quiser preservar o banco: a opcao `-v` apaga o volume de dados.
