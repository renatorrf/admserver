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
no provedor. Nao ha cache persistente: a resposta do provedor testada exige
revalidacao/nao armazenamento; downloads simultaneos iguais sao compartilhados.
Nao existe fallback para servidores OSM bloqueados.

O mapa mantem a atribuicao OpenStreetMap e Geoapify. Falhas de rede, limite ou
configuracao mostram um aviso com nova tentativa, preservando marcadores e
trajetos. O `no-referrer` do app e preservado para os links privados.

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
