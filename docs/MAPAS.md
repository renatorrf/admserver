# Mapas do ADM Taxi

As telas de acompanhamento, dashboard e rastreamento publico usam o helper
`addMapTiles` do frontend, com imagens Geoapify no estilo `osm-carto`.
Nao devem acessar diretamente os servidores comunitarios de imagens do OSM.

## Configuracao e publicacao

- A API precisa de `GEOAPIFY_API_KEY` no ambiente (incluindo Cloud Run).
- A chave permanece no backend; nao colocar em `environment.ts` ou no APK.
- Publicar a API antes do frontend: o novo frontend utiliza
  `GET /api/v1/public/mapa/:z/:x/:y.png` sem autenticacao, inclusive nos links
  privados de rastreamento. O endpoint usa um provedor e estilo fixos,
  valida coordenadas e possui limites de concorrencia e requisicoes por IP.
  Downloads distintos sao espacados por 100 ms em cada instancia; monitorar
  o limite global da conta caso o Cloud Run utilize varias instancias.
- Para o APK instalado receber esta alteracao, gerar e distribuir uma nova
  versao com o frontend atualizado.
- Nao ha migracao de banco. Nenhuma publicacao e feita automaticamente.

## Uso e falhas

O uso das imagens consome a cota da chave Geoapify existente. Monitorar a cota
no provedor. Imagens com permissao explicita `public` e validade positiva em
`Cache-Control` sao reutilizadas por ate 10 minutos, descontando o header `Age`.
O cache LRU em memoria e limitado a 256 imagens e 16 MiB por instancia; o navegador
recebe a validade restante e ETag para revalidacao. Respostas `private`, `no-store`,
`no-cache`, expiradas ou sem permissao explicita nao sao armazenadas.
Downloads simultaneos iguais sao compartilhados. Nao existe fallback para
servidores OSM bloqueados e o cache nunca armazena localizacoes de pessoas.

O mapa mantem a atribuicao OpenStreetMap e Geoapify. Uma imagem que falhar recebe
uma unica nova tentativa automatica; a tentativa manual afeta apenas imagens
com erro, sem refazer as que ja carregaram. A atualizacao de indicadores nao
destroi o mapa do dashboard. Falhas preservam marcadores e trajetos. O
`no-referrer` do app e preservado para os links privados.

O header `X-Map-Cache` indica `HIT`, `MISS` ou `SHARED` para diagnostico. Erros do
provedor geram logs com motivo e status HTTP, sem gravar a chave ou URL secreta.
Publicar o backend atualizado para ativar o cache em producao; publicar apenas
o frontend aplica as melhorias visuais e de novas tentativas, mas nao o cache da API.

## Validacao local

No backend: `npm test`, `npm run build` e `npm run lint`.
No frontend: `npm test -- --watch=false --browsers=ChromeHeadless`,
`npm run build -- --configuration production` e `npm run lint`.
O script `scripts/test-public-tracking-ui.cjs` do frontend testa o mapa e a
recuperacao de falhas em 320, 390 e 1440 px. Por padrao utiliza imagens de teste;
com `MAP_TILES_LIVE=1`, utiliza a chave local da API para validar imagens reais.
Executar o build do backend antes do script.

Referencias:
- https://operations.osmfoundation.org/policies/tiles/
- https://apidocs.geoapify.com/docs/maps/map-tiles/
