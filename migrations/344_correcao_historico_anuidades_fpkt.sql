-- ============================================================
-- 344 - Correcao do historico de anuidades da FPKT (2017-2025)
-- ------------------------------------------------------------
-- A 282 carregou o historico a partir da planilha organizada
-- ("Anuidade Dojos.xlsx"), que tinha erros de digitacao na coluna de
-- parcelas e em alguns valores. Esta migration reescreve as anuidades
-- que divergem da planilha-fonte da federacao ("TAXAS ADM aura 2026.xlsx",
-- grade mensal por ano, com legenda de cores da forma de pagamento e
-- tabela de precos 1x/2x/4x). Decisoes fechadas com o Caio em 16/09/2026.
--
-- 76 anuidades corrigidas + 5 novas (Hasha 2017, Instituto Shitei
-- 2017-2019, Areikan Ibitinga 2019). Principais correcoes:
--   * Tcho Wa 2025: 2a parcela 1.590 -> 150.
--   * Barueri 2023 e Tcho Wa 2023: plano 4x R$140 -> anuidade 560.
--   * Simoes 2017: 4a parcela paga (nov) -> quitada.
--   * Plano/numero de parcelas pela fonte (MA Fight 2019/2024/2025,
--     Bushido 2022/2024, Kishintai 2018/2019, Hasha/MAC 2019, ...).
--   * 2020: parcelas ISENTAS (pandemia) saem do plano (CEU, Tcho Wa,
--     Santa Sofia, Clube Comercial).
--   * Tcho Wa "2018" (R$240) e pagamento de 2016 (nota da fonte):
--     reference_period vira '2016'.
--   * Hasha 2018 (1.564,82): jan-abr/2018 = taxa 2017 (nota da fonte);
--     2018 fica com mai-dez (1.044,00).
--   * Nacoes Unidas 2019: duas linhas da fonte somadas + filiacao R$150.
--   * Areikan 2019: R$630 = anuidade R$450 + refiliacao R$180.
--   * Datas no mes da fonte e forma de pagamento pela legenda de cores.
-- Valores fora da tabela ficam como a fonte registra (sem gerar divida).
--
-- Modelo gravado (o mesmo do app): cabecalho = soma das parcelas
-- (filiacao incluida, kind='filiacao', seq 0); uma parcela por parcela do
-- plano, e cada recebimento vira uma linha em karate_annuity_payments.
-- Quando o valor pago nao fecha com a tabela, uma parcela por pagamento.
--
-- Protecoes:
--   * Banco sem a FPKT (CI): nao faz nada.
--   * Ja aplicada (marcador = anuidade nova 943707e4-dbe3-5ceb-89aa-519f693a2b8e): nao faz nada.
--   * Anuidade editada pelo app depois da carga da 282 (updated_at),
--     ou com lancamento financeiro/recebimento ligado: ABORTA. O que a
--     federacao mudou no app vale mais que a planilha.
-- ============================================================

-- Sem BEGIN/COMMIT proprios: o runner (scripts/migrate.js) ja envolve o
-- arquivo numa transacao, e o bloco DO abaixo e atomico por si so (o psql
-- do CI roda em autocommit).
DROP TABLE IF EXISTS _m344_hdr, _m344_inst, _m344_led;
CREATE TEMP TABLE _m344_hdr (id uuid, dojo_id uuid, reference_period text, plan text, amount numeric,
  status text, paid_at date, payment_method text, due_date date, is_new boolean);
CREATE TEMP TABLE _m344_inst (id uuid, annuity_id uuid, seq smallint, kind text, amount numeric,
  amount_paid numeric, due_date date, paid_at timestamptz, payment_method text, status text);
CREATE TEMP TABLE _m344_led (id uuid, installment_id uuid, annuity_id uuid, amount numeric,
  paid_at timestamptz, payment_method text);

INSERT INTO _m344_hdr VALUES
    ('c46f50d0-2d06-4190-886a-f3a8b34e55fb'::uuid,'c5e24753-90fe-4c06-b356-331530707f6a'::uuid,'2017'::text,'trimestral'::text,500.00::numeric,'paid'::text,'2017-11-30'::date,'pix'::text,'2017-11-30'::date,false::boolean),  -- 2017 ASSOCIAÇÃO SHOBUKAN JOSÉ BONIFÁCIO
    ('e9cd9619-0c6c-4bef-a103-2cf3740d15cd','19122cb3-7396-406a-9aab-238706a4e6d9','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 ASSOCIAÇÃO SIMÕES
    ('418d7bd5-af90-4b10-a5e1-cfd7fb567559','ffc08219-5b4b-454c-b233-6dcae4902925','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 CEU UIRAPURU
    ('82a53056-75d5-4956-97c1-965fc6030d46','d3ba921f-adb3-44a9-bfcd-20831a2f85ef','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 CLUBE COMERCIAL DE LORENA
    ('df19d106-3fc9-4f82-820a-daa74b44fe3a','bceaf741-43ef-4780-88ff-59782c6cb1df','2017','trimestral',502.94,'paid','2017-11-30','dinheiro','2017-11-30',false),  -- 2017 CPP - BAURU
    ('201da200-ed06-4365-bd73-d8d22b88b3be','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 DOJÔ KARATÊ FORÇA ZEN
    ('2975bfb1-5c3e-49ab-ade0-07d820ea3463','f2586f02-c55d-4883-943e-864123f59407','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 ESPORTE CLUBE SANTA SOFIA
    ('0290a134-493e-444a-a0c9-b013037b991e','8dd7f027-3ea0-49e4-8f7d-502fa18dd4b7','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 GRUPO NAÇÕES UNIDAS
    ('943707e4-dbe3-5ceb-89aa-519f693a2b8e','a9c62d06-435a-4662-9925-a535098d7eb0','2017','trimestral',520.82,'paid','2018-04-30',NULL,'2017-11-30',true),  -- 2017 HASHA DOJO
    ('af1801bd-9c5e-4e95-8fdb-40b1311c777b','4a88e69d-6e7b-4005-bd2e-334b7ff31470','2017','semestral',390.00,'paid','2017-07-31','dinheiro','2017-11-30',false),  -- 2017 IKIGAI DÔJO
    ('39de9cc1-9c03-5536-8129-cfdda192a9d0','c4339c8e-f813-4c25-b17a-474b1affaf18','2017','semestral',480.00,'paid','2017-11-30',NULL,'2017-11-30',true),  -- 2017 INSTITUTO SHITEI
    ('9bfb406c-a020-4dbe-8a4d-a78f02247dd2','0e05d6b5-6e30-4aa8-b21d-9005ee706cfe','2017','trimestral',500.00,'paid','2017-10-31','pix','2017-11-30',false),  -- 2017 KISHINTAI GREMIO LIEBHERR
    ('b77bb18d-0c2a-47d9-893e-69995bfb1271','199a31f7-c9ae-40ed-a842-6cfe2a7a0d64','2017','trimestral',500.00,'paid','2017-11-30','pix','2017-11-30',false),  -- 2017 MAC LORENA
    ('4b7d10ec-b8e6-4f1e-8aac-abc48535c869','19122cb3-7396-406a-9aab-238706a4e6d9','2018','trimestral',500.00,'paid','2018-12-31','dinheiro','2018-11-30',false),  -- 2018 ASSOCIAÇÃO SIMÕES
    ('64b7c07d-440d-49da-ba08-40752fc56637','ffc08219-5b4b-454c-b233-6dcae4902925','2018','trimestral',500.00,'paid','2018-12-31','pix','2018-11-30',false),  -- 2018 CEU UIRAPURU
    ('582217c1-836e-4828-a6f2-e2f2633ee060','d3ba921f-adb3-44a9-bfcd-20831a2f85ef','2018','trimestral',500.00,'paid','2018-11-30','pix','2018-11-30',false),  -- 2018 CLUBE COMERCIAL DE LORENA
    ('9ef05b7f-dec6-40b7-a156-4da4e3467a94','bceaf741-43ef-4780-88ff-59782c6cb1df','2018','trimestral',535.70,'paid','2018-12-31','pix','2018-11-30',false),  -- 2018 CPP - BAURU
    ('66f767d4-ad54-49d9-9838-4dc83ea584e2','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2018','trimestral',490.00,'paid','2018-12-31','credito_cbkt','2018-08-31',false),  -- 2018 DOJÔ KARATÊ FORÇA ZEN
    ('794d63bf-ecd0-426e-9870-369cb2a8760a','f2586f02-c55d-4883-943e-864123f59407','2018','trimestral',500.00,'paid','2018-11-30','pix','2018-11-30',false),  -- 2018 ESPORTE CLUBE SANTA SOFIA
    ('9d63c6ea-29e4-4217-b339-eecbd9bd743e','8dd7f027-3ea0-49e4-8f7d-502fa18dd4b7','2018','trimestral',500.00,'paid','2018-11-30','pix','2018-11-30',false),  -- 2018 GRUPO NAÇÕES UNIDAS
    ('b7227a2f-5c25-403d-aaac-ace1f96143e7','a9c62d06-435a-4662-9925-a535098d7eb0','2018','anual',1044.00,'paid','2018-12-31','pix','2018-05-31',false),  -- 2018 HASHA DOJO
    ('a2dd5311-47d6-51d1-aa0d-6944e4a2a83b','c4339c8e-f813-4c25-b17a-474b1affaf18','2018','anual',430.00,'paid','2018-06-30','pix','2018-05-31',true),  -- 2018 INSTITUTO SHITEI
    ('33103410-96b7-4579-9a72-7c948ffdbcf5','0e05d6b5-6e30-4aa8-b21d-9005ee706cfe','2018','trimestral',500.00,'paid','2018-12-31','pix','2018-11-30',false),  -- 2018 KISHINTAI GREMIO LIEBHERR
    ('06a1a5cd-4a00-42ef-89db-42223ad59f50','199a31f7-c9ae-40ed-a842-6cfe2a7a0d64','2018','semestral',480.00,'paid','2018-11-30','pix','2018-11-30',false),  -- 2018 MAC LORENA
    ('34399973-14e6-47ee-af96-31720975b3a0','85dd885e-0266-4a47-b7fe-cf7f906c41c1','2018','anual',430.00,'paid','2018-06-30','credito_cbkt','2018-05-31',false),  -- 2018 NIPPON COUNTRY CLUB
    ('1d9ceec1-6f5f-445a-aefa-5cbc53bf0d60','4b4ef529-c066-4791-b7a3-f204bc24a940','2016',NULL,240.00,'paid','2018-07-31','pix','2018-05-31',false),  -- 2018 TCHO WA ASSOC. DE KARATE TRADICIONAL
    ('4b8afba1-b0c8-54e1-bcb7-54262e585acb','95dc30c8-8385-4d37-952a-00ff66dcb1dd','2019','anual',225.00,'paid','2019-10-31',NULL,'2019-05-31',true),  -- 2019 AREIKAN IBITINGA
    ('00570113-cd26-43ba-808c-dff1c8d691b4','032f93ac-6aec-4598-8c91-bff0801f037f','2019','anual',450.00,'paid','2019-07-31','pix','2019-05-31',false),  -- 2019 ASSOCIAÇÃO SHOBUKAN RIO PRETO
    ('15bf9b5c-bafa-4991-9ae8-e00bf0f4b049','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2019','trimestral',520.00,'paid','2019-12-31','dinheiro','2019-11-30',false),  -- 2019 DOJÔ KARATÊ FORÇA ZEN
    ('967e2297-3c06-432d-ab50-52a8386ce043','d6f57b94-3169-4f54-853a-865f5f9fe774','2019','anual',630.00,'paid','2019-01-31','pix','2019-05-31',false),  -- 2019 ESCOLA DE KARATÊ AREIKAN
    ('4b673e7d-e1af-4906-b459-43ff2fc82c76','8dd7f027-3ea0-49e4-8f7d-502fa18dd4b7','2019','trimestral',670.00,'paid','2019-11-30','pix','2019-11-30',false),  -- 2019 GRUPO NAÇÕES UNIDAS
    ('a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7','a9c62d06-435a-4662-9925-a535098d7eb0','2019','trimestral',520.00,'paid','2019-11-30','pix','2019-11-30',false),  -- 2019 HASHA DOJO
    ('cf290543-3e2e-595c-a295-4425e95a1e79','c4339c8e-f813-4c25-b17a-474b1affaf18','2019','trimestral',520.00,'paid','2019-12-31','dinheiro','2019-11-30',true),  -- 2019 INSTITUTO SHITEI
    ('dfe94ce2-0d18-466a-aadb-3c96172b73da','0e05d6b5-6e30-4aa8-b21d-9005ee706cfe','2019','trimestral',520.00,'paid','2019-12-31','pix','2019-11-30',false),  -- 2019 KISHINTAI GREMIO LIEBHERR
    ('25828459-1dd5-4999-8d1f-e96bb7a34523','08b7259c-f5b7-4863-bd00-5b041d93bed2','2019','anual',450.80,'paid','2019-04-30','credito_cbkt','2019-05-31',false),  -- 2019 MA FIGHT
    ('7aa59cbf-816f-463c-9dfb-010bf046938e','199a31f7-c9ae-40ed-a842-6cfe2a7a0d64','2019','trimestral',520.00,'paid','2019-12-31','pix','2019-11-30',false),  -- 2019 MAC LORENA
    ('b6d664f5-6811-4538-92d4-de7213a87cb3','4b4ef529-c066-4791-b7a3-f204bc24a940','2019','trimestral',520.00,'paid','2019-11-30','pix','2019-11-30',false),  -- 2019 TCHO WA ASSOC. DE KARATE TRADICIONAL
    ('442fdcbb-3a0f-474e-8715-6668487d2a83','bb5e5cd9-5d56-4c25-b069-026b35d55c05','2020','anual',450.00,'paid','2020-09-30','dinheiro','2020-05-31',false),  -- 2020 ASSOCIAÇÃO LEMBUKAN DE KARATÊ
    ('5023e599-7591-46be-a274-7b8d8faf9e2c','032f93ac-6aec-4598-8c91-bff0801f037f','2020','anual',450.00,'paid','2021-02-28','outro','2020-05-31',false),  -- 2020 ASSOCIAÇÃO SHOBUKAN RIO PRETO
    ('97d06e18-6b27-41ef-90dd-97fc3532c39c','ffc08219-5b4b-454c-b233-6dcae4902925','2020','trimestral',390.00,'paid','2020-09-30','pix','2020-08-31',false),  -- 2020 CEU UIRAPURU
    ('fd9305a6-3844-4887-985f-bfc22d06e712','d3ba921f-adb3-44a9-bfcd-20831a2f85ef','2020','trimestral',260.00,'paid','2020-05-31','pix','2020-05-31',false),  -- 2020 CLUBE COMERCIAL DE LORENA
    ('18407eb5-3a56-428e-a847-4f2eed2d01bb','fdab7e2f-67e2-4c6a-b104-00efca8cd9b1','2020','trimestral',520.00,'paid','2020-11-30','pix','2020-11-30',false),  -- 2020 DOJO BUSHIDO
    ('b4f1cea2-dac4-4802-a211-f1b4da3123f4','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2020','trimestral',410.00,'paid','2020-11-30','pix','2020-05-31',false),  -- 2020 DOJÔ KARATÊ FORÇA ZEN
    ('39cfeb23-3b86-4e2c-9ca5-5822c83e66f4','f2586f02-c55d-4883-943e-864123f59407','2020','trimestral',390.00,'paid','2020-08-31','pix','2020-08-31',false),  -- 2020 ESPORTE CLUBE SANTA SOFIA
    ('e67f1599-04fd-4f1d-abfe-524982de0da6','4a88e69d-6e7b-4005-bd2e-334b7ff31470','2020','anual',400.00,'paid','2020-09-30','pix','2020-05-31',false),  -- 2020 IKIGAI DÔJO
    ('af429fe5-28ae-47dc-a311-855b334ea844','4b4ef529-c066-4791-b7a3-f204bc24a940','2020','trimestral',390.00,'paid','2020-12-31','pix','2020-11-30',false),  -- 2020 TCHO WA ASSOC. DE KARATE TRADICIONAL
    ('b3380551-3a25-4c19-90dd-d8bac9805d9f','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2021','semestral',500.00,'paid','2021-12-31','dinheiro','2021-11-30',false),  -- 2021 DOJÔ KARATÊ FORÇA ZEN
    ('9637f251-e900-420d-8e85-b28467810d52','08b7259c-f5b7-4863-bd00-5b041d93bed2','2021','semestral',500.00,'paid','2021-11-30','credito_exame','2021-11-30',false),  -- 2021 MA FIGHT
    ('6039b798-90ee-447d-97a4-b6fe0e131f8d','4d5be7bd-9dbc-4412-aa21-764f55849941','2022','trimestral',526.00,'paid','2022-11-30','pix','2022-08-31',false),  -- 2022 BASSAI DAI ACADEMIA
    ('922fd55a-ce92-4895-882c-20c4c76c9fbf','ffc08219-5b4b-454c-b233-6dcae4902925','2022','anual',450.00,'paid','2022-05-31','credito_exame','2022-05-31',false),  -- 2022 CEU UIRAPURU
    ('1eeebba1-9489-4b6c-ba77-c27f89f80793','fdab7e2f-67e2-4c6a-b104-00efca8cd9b1','2022','trimestral',520.00,'paid','2022-11-30','pix','2022-11-30',false),  -- 2022 DOJO BUSHIDO
    ('5fb79045-1a15-4b6d-a1cd-57b1f9a3784c','08b7259c-f5b7-4863-bd00-5b041d93bed2','2022','anual',450.00,'paid','2022-07-31','pix','2022-05-31',false),  -- 2022 MA FIGHT
    ('4116f847-0278-450f-9f42-1ec949b1fec4','4b4ef529-c066-4791-b7a3-f204bc24a940','2022','trimestral',520.00,'paid','2022-12-31','pix','2022-11-30',false),  -- 2022 TCHO WA ASSOC. DE KARATE TRADICIONAL
    ('41884f9a-cee1-4e4d-a44d-e30e9afc0e8c','24608129-e4a0-4027-a968-da6d27c2698b','2023','anual',480.00,'paid','2023-02-28','credito_exame','2023-05-31',false),  -- 2023 ASSOCIAÇÃO SHOBUKAN ANDRADINA
    ('e9691e6c-c007-48c8-892f-02d56e35d856','48c1dec1-e9c6-4436-97ee-f7c85bc07511','2023','anual',480.00,'paid','2023-05-31','boleto','2023-05-31',false),  -- 2023 CLUBE PAINEIRAS
    ('d1a2d469-5cd7-4aae-a960-cfade2207f40','fdab7e2f-67e2-4c6a-b104-00efca8cd9b1','2023','trimestral',599.46,'paid','2023-08-31','pix','2023-08-31',false),  -- 2023 DOJO BUSHIDO
    ('969156ac-f108-4a74-a5de-ed11d6437c21','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2023','semestral',530.00,'paid','2023-09-30','credito_cbkt','2023-11-30',false),  -- 2023 DOJÔ KARATÊ FORÇA ZEN
    ('c062a4ee-aa9a-47fe-afce-cde499581bf6','4a88e69d-6e7b-4005-bd2e-334b7ff31470','2023','anual',480.00,'paid','2023-08-31','credito_exame','2023-05-31',false),  -- 2023 IKIGAI DÔJO
    ('f763c512-d1eb-43f9-a9c4-001f100e2b44','85dd885e-0266-4a47-b7fe-cf7f906c41c1','2023','anual',480.00,'paid','2023-09-30','dinheiro','2023-05-31',false),  -- 2023 NIPPON COUNTRY CLUB
    ('5ef42424-ae75-475f-9a06-056ff57aeb2e','3babde22-0d93-45d3-8e27-80d136de368c','2023','trimestral',560.00,'paid','2023-09-30','dinheiro','2023-11-30',false),  -- 2023 SECRETARIA DE ESPORTES DE BARUERI
    ('83d56c0e-72ca-4124-a1d0-6392fd077b2d','4b4ef529-c066-4791-b7a3-f204bc24a940','2023','trimestral',560.00,'paid','2023-12-30','pix','2023-11-30',false),  -- 2023 TCHO WA ASSOC. DE KARATE TRADICIONAL
    ('77a5695c-215a-49e3-986d-51aa18dd4778','95dc30c8-8385-4d37-952a-00ff66dcb1dd','2024','anual',500.00,'paid','2024-02-28','credito_exame','2024-05-31',false),  -- 2024 AREIKAN IBITINGA
    ('e2b758c8-9d25-458f-bb93-39ef02500100','fdab7e2f-67e2-4c6a-b104-00efca8cd9b1','2024','trimestral',600.00,'paid','2024-10-31','pix','2024-11-30',false),  -- 2024 DOJO BUSHIDO
    ('9340f9f8-7c7a-4ed2-a37d-9d14ba85269d','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2024','semestral',560.00,'paid','2024-12-30','pix','2024-11-30',false),  -- 2024 DOJÔ KARATÊ FORÇA ZEN
    ('3abc01c3-3f3b-4d4b-8d60-2102300118d1','f2586f02-c55d-4883-943e-864123f59407','2024','anual',500.00,'paid','2024-05-31','boleto','2024-05-31',false),  -- 2024 ESPORTE CLUBE SANTA SOFIA
    ('958d5489-ce57-4805-ac99-175f87f691c0','7da0a28a-1465-47f2-a458-af9d13f914cc','2024','semestral',560.00,'paid','2024-11-30','pix','2024-11-30',false),  -- 2024 KANO DOJO
    ('a5c56f0c-9c19-49de-880e-db70b7c283c1','0e05d6b5-6e30-4aa8-b21d-9005ee706cfe','2024','anual',500.00,'paid','2024-05-31','credito_exame','2024-05-31',false),  -- 2024 KISHINTAI GREMIO LIEBHERR
    ('a5288db5-c2c4-4657-817e-925ecb2d6135','9b1be069-ff2c-4a9d-899e-e402c31ebf8f','2024','anual',320.00,'paid','2024-10-31','pix','2024-11-30',false),  -- 2024 KONDEI
    ('9ae079b7-2af2-4745-968f-6348bd4ed68e','08b7259c-f5b7-4863-bd00-5b041d93bed2','2024','anual',500.00,'paid','2024-07-30','pix','2024-05-31',false),  -- 2024 MA FIGHT
    ('a136cfd4-6a7c-45b2-93f7-0ece44b7217c','3babde22-0d93-45d3-8e27-80d136de368c','2024','trimestral',600.00,'paid','2024-11-30','pix','2024-11-30',false),  -- 2024 SECRETARIA DE ESPORTES DE BARUERI
    ('b0e863ea-dac2-45a9-804c-0ed7bdf8266e','4b4ef529-c066-4791-b7a3-f204bc24a940','2024','trimestral',600.00,'paid','2024-12-30','pix','2024-11-30',false),  -- 2024 TCHO WA ASSOC. DE KARATE TRADICIONAL
    ('05f8c3b1-05c2-4fdd-8569-3ca891c72775','c5e24753-90fe-4c06-b356-331530707f6a','2025','semestral',560.00,'paid','2025-12-30','pix','2025-11-30',false),  -- 2025 ASSOCIAÇÃO SHOBUKAN JOSÉ BONIFÁCIO
    ('e9f6bd2c-a3d9-44d4-8c32-9690b5fbe7bc','032f93ac-6aec-4598-8c91-bff0801f037f','2025','anual',640.00,'paid','2025-07-30','pix','2025-05-31',false),  -- 2025 ASSOCIAÇÃO SHOBUKAN RIO PRETO
    ('1d77b8f5-49e3-4208-b112-51f580a13425','e1c2fb6a-5f78-4426-90a4-a91858c6b361','2025','semestral',510.00,'paid','2025-03-30','pix','2025-11-30',false),  -- 2025 DOJÔ KARATÊ FORÇA ZEN
    ('3516edcd-41a5-4ea7-bd14-e7a48360a2fd','f2586f02-c55d-4883-943e-864123f59407','2025','anual',500.00,'paid','2025-05-31','boleto','2025-05-31',false),  -- 2025 ESPORTE CLUBE SANTA SOFIA
    ('66d25ed8-c18d-44e3-a4e6-8f1e4b0f3c54','4a88e69d-6e7b-4005-bd2e-334b7ff31470','2025','anual',495.00,'paid','2025-03-30','pix','2025-05-31',false),  -- 2025 IKIGAI DÔJO
    ('831fe3c4-0e6a-4360-beb9-f1537e09aecc','7da0a28a-1465-47f2-a458-af9d13f914cc','2025','semestral',500.00,'paid','2025-09-30','pix','2025-11-30',false),  -- 2025 KANO DOJO
    ('12f7c790-9b58-4350-8683-7a5533a73384','08b7259c-f5b7-4863-bd00-5b041d93bed2','2025','anual',500.00,'paid','2025-06-30','pix','2025-05-31',false),  -- 2025 MA FIGHT
    ('6ac6d03a-4b96-4e38-828d-001de6990860','85dd885e-0266-4a47-b7fe-cf7f906c41c1','2025','anual',500.00,'paid','2025-06-30','boleto','2025-05-31',false),  -- 2025 NIPPON COUNTRY CLUB
    ('94dbd8ac-27e8-4805-ace6-2c7aef1bbc8d','7b7d0a18-8d1f-4b5b-95e9-7ba0ed009279','2025','semestral',560.00,'paid','2025-07-30','pix','2025-11-30',false),  -- 2025 SHOBUKAN SAO PAULO
    ('7971ae36-8788-4813-9949-a1041cd3fff0','4b4ef529-c066-4791-b7a3-f204bc24a940','2025','trimestral',600.00,'paid','2025-12-30','pix','2025-11-30',false);  -- 2025 TCHO WA ASSOC. DE KARATE TRADICIONAL

INSERT INTO _m344_inst VALUES
    ('04b9782c-aed9-5ea1-bbf7-fc589a21c8a0'::uuid,'c46f50d0-2d06-4190-886a-f3a8b34e55fb'::uuid,1::smallint,'anuidade'::text,125.00::numeric,125.00::numeric,'2017-02-28'::date,'2017-02-28 12:00:00-03'::timestamptz,'pix'::text,'paid'::text),
    ('46eb6cef-0f85-59b4-9925-94afd74e45cc','c46f50d0-2d06-4190-886a-f3a8b34e55fb',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('8e276639-4a49-5b71-9142-05ee22e46729','c46f50d0-2d06-4190-886a-f3a8b34e55fb',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('f48a25f6-45df-59a9-b738-2b1a1cc39a14','c46f50d0-2d06-4190-886a-f3a8b34e55fb',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('db367ee4-2bdb-56c4-8bd5-c0936a8778db','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('41956fce-7e32-5421-8b42-2dad6cb13ecb','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('a0273623-5d58-56df-b8da-4673c4e3d83e','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('4a0ee290-fea1-5174-9850-35a836be43c5','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('6ece8c67-8577-5218-9540-142e4cad4606','418d7bd5-af90-4b10-a5e1-cfd7fb567559',1,'anuidade',125.00,125.00,'2017-02-28','2017-11-30 12:00:00-03','pix','paid'),
    ('d4506322-3db9-5a37-b6d5-17d0bba4cbe7','418d7bd5-af90-4b10-a5e1-cfd7fb567559',2,'anuidade',125.00,125.00,'2017-05-31','2017-11-30 12:00:00-03','pix','paid'),
    ('03945d91-2481-5b84-a89b-085e78242c8e','418d7bd5-af90-4b10-a5e1-cfd7fb567559',3,'anuidade',125.00,125.00,'2017-08-31','2017-11-30 12:00:00-03','pix','paid'),
    ('68764c9a-46c5-5202-80fd-e3cd844fcf55','418d7bd5-af90-4b10-a5e1-cfd7fb567559',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('a5ebbed7-5ded-563d-ae8e-b5bca5dca9e7','82a53056-75d5-4956-97c1-965fc6030d46',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('d190c86d-61b5-564c-91ad-c59e4b7600b8','82a53056-75d5-4956-97c1-965fc6030d46',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('431554ab-1198-57e2-8cd4-8bcf2effc6a7','82a53056-75d5-4956-97c1-965fc6030d46',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('dd4986e2-72b4-5d94-9cf3-e8ec70691891','82a53056-75d5-4956-97c1-965fc6030d46',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('22f4928a-d7ba-5b09-9bfe-cb48d139f278','df19d106-3fc9-4f82-820a-daa74b44fe3a',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('cbb7b483-c85e-50dd-ba28-890ea6c125d1','df19d106-3fc9-4f82-820a-daa74b44fe3a',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('ec560a45-4932-534b-b625-5aaf346e4171','df19d106-3fc9-4f82-820a-daa74b44fe3a',3,'anuidade',127.94,127.94,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('7f5d9cf7-a67d-5e63-b2d2-57f3a85f347d','df19d106-3fc9-4f82-820a-daa74b44fe3a',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','dinheiro','paid'),
    ('624f3c09-bdf2-51a1-af81-6a36f10e84a1','201da200-ed06-4365-bd73-d8d22b88b3be',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('cd144ee1-7bcc-5d00-8b47-3afdeca71a34','201da200-ed06-4365-bd73-d8d22b88b3be',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('f93e802e-d127-5f3c-81f5-2b8e93095c25','201da200-ed06-4365-bd73-d8d22b88b3be',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('37ea5692-f6db-5a1d-8064-02466b14a7e7','201da200-ed06-4365-bd73-d8d22b88b3be',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('791d1f62-a71c-5ab1-ae52-e6a6549ed535','2975bfb1-5c3e-49ab-ade0-07d820ea3463',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('da55043d-8fd5-5e83-9675-128bb76e5272','2975bfb1-5c3e-49ab-ade0-07d820ea3463',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('efab8bdd-93a3-5cb1-8159-2133741a1725','2975bfb1-5c3e-49ab-ade0-07d820ea3463',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('8eab208d-cb8c-53e4-bba0-6cd86143245e','2975bfb1-5c3e-49ab-ade0-07d820ea3463',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('06c3d9a7-ea3e-51a4-b512-c82f82bc183b','0290a134-493e-444a-a0c9-b013037b991e',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('9fe1818c-4061-54eb-acc2-b01590ecefca','0290a134-493e-444a-a0c9-b013037b991e',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('467a42ca-d695-509e-bf3d-50082580ecdb','0290a134-493e-444a-a0c9-b013037b991e',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','dinheiro','paid'),
    ('1be8905b-6fbf-568b-a9e5-b0f99e069711','0290a134-493e-444a-a0c9-b013037b991e',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('f3bf47ad-4a5a-5ac2-98d6-afe45e69e173','943707e4-dbe3-5ceb-89aa-519f693a2b8e',1,'anuidade',130.04,130.04,'2017-02-28','2018-01-31 12:00:00-03',NULL,'paid'),
    ('42810284-1974-5f17-ad0a-8dc57462ca1f','943707e4-dbe3-5ceb-89aa-519f693a2b8e',2,'anuidade',128.78,128.78,'2017-05-31','2018-02-28 12:00:00-03',NULL,'paid'),
    ('b215a0cb-3965-5cde-b05b-65fc9740897d','943707e4-dbe3-5ceb-89aa-519f693a2b8e',3,'anuidade',130.00,130.00,'2017-08-31','2018-03-31 12:00:00-03',NULL,'paid'),
    ('4ef8b117-03a8-559b-9f54-c5da7a24fa65','943707e4-dbe3-5ceb-89aa-519f693a2b8e',4,'anuidade',132.00,132.00,'2017-11-30','2018-04-30 12:00:00-03',NULL,'paid'),
    ('c3d1e974-a519-58d1-bef7-d6389d72dde4','af1801bd-9c5e-4e95-8fdb-40b1311c777b',1,'anuidade',150.00,150.00,'2017-05-31','2017-06-30 12:00:00-03','dinheiro','paid'),
    ('825b90fc-73ec-5b51-85b0-6afa0a92e68c','af1801bd-9c5e-4e95-8fdb-40b1311c777b',2,'anuidade',240.00,240.00,'2017-11-30','2017-07-31 12:00:00-03','dinheiro','paid'),
    ('8ecaa901-3a48-565f-a5fd-67154f902b3c','39de9cc1-9c03-5536-8129-cfdda192a9d0',1,'anuidade',240.00,240.00,'2017-05-31','2017-05-31 12:00:00-03',NULL,'paid'),
    ('12487681-1454-5c5e-a730-e158e0875b12','39de9cc1-9c03-5536-8129-cfdda192a9d0',2,'anuidade',240.00,240.00,'2017-11-30','2017-11-30 12:00:00-03',NULL,'paid'),
    ('524e7e05-2dc5-5413-b6c9-baa0522959a5','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('40090bc7-8ac5-5f00-9ccf-446c4f1efb9a','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('221bdc20-28af-59d2-bb65-6539ececf7a1','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('38d180b9-5eb1-5191-87d4-9a20fbb42017','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',4,'anuidade',125.00,125.00,'2017-11-30','2017-10-31 12:00:00-03','pix','paid'),
    ('c0f3394e-c0b8-5901-9351-99ba1614feea','b77bb18d-0c2a-47d9-893e-69995bfb1271',1,'anuidade',125.00,125.00,'2017-02-28','2017-02-28 12:00:00-03','pix','paid'),
    ('59c35d47-a283-570c-94e1-07c5a186340f','b77bb18d-0c2a-47d9-893e-69995bfb1271',2,'anuidade',125.00,125.00,'2017-05-31','2017-05-31 12:00:00-03','pix','paid'),
    ('aceb3f6e-45c9-54ee-98a3-1c070322ae15','b77bb18d-0c2a-47d9-893e-69995bfb1271',3,'anuidade',125.00,125.00,'2017-08-31','2017-08-31 12:00:00-03','pix','paid'),
    ('0c32b5a6-b6e6-5a20-bd13-ae493a4388b3','b77bb18d-0c2a-47d9-893e-69995bfb1271',4,'anuidade',125.00,125.00,'2017-11-30','2017-11-30 12:00:00-03','pix','paid'),
    ('09aac587-cd39-5c23-8bba-a03110b147dc','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',1,'anuidade',125.00,125.00,'2018-02-28','2018-12-31 12:00:00-03','dinheiro','paid'),
    ('4ec1d773-0bfa-5f8b-8b87-ee6213d83e12','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',2,'anuidade',125.00,125.00,'2018-05-31','2018-12-31 12:00:00-03','dinheiro','paid'),
    ('ee026593-913d-5844-a91a-5f86a7832a17','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',3,'anuidade',125.00,125.00,'2018-08-31','2018-12-31 12:00:00-03','dinheiro','paid'),
    ('8e8d32c7-e928-55f2-b6e0-14261c356f0b','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',4,'anuidade',125.00,125.00,'2018-11-30','2018-12-31 12:00:00-03','dinheiro','paid'),
    ('0c74bbbc-18bc-58cd-8a7c-975e214b93ad','64b7c07d-440d-49da-ba08-40752fc56637',1,'anuidade',125.00,125.00,'2018-02-28','2018-02-28 12:00:00-03','pix','paid'),
    ('750d4af6-e4d1-57ad-990d-a26342099d9f','64b7c07d-440d-49da-ba08-40752fc56637',2,'anuidade',125.00,125.00,'2018-05-31','2018-06-30 12:00:00-03','pix','paid'),
    ('76536726-d347-5df2-b466-0646019512a8','64b7c07d-440d-49da-ba08-40752fc56637',3,'anuidade',125.00,125.00,'2018-08-31','2018-11-30 12:00:00-03','pix','paid'),
    ('b3b6d9ae-dcab-537d-b8d2-a3d8b2c44c72','64b7c07d-440d-49da-ba08-40752fc56637',4,'anuidade',125.00,125.00,'2018-11-30','2018-12-31 12:00:00-03','pix','paid'),
    ('f70aacbd-22c4-51c0-a77f-2f96e8ac7f59','582217c1-836e-4828-a6f2-e2f2633ee060',1,'anuidade',125.00,125.00,'2018-02-28','2018-02-28 12:00:00-03','pix','paid'),
    ('100c445f-6f79-5038-aa24-465f5b293e6a','582217c1-836e-4828-a6f2-e2f2633ee060',2,'anuidade',125.00,125.00,'2018-05-31','2018-05-31 12:00:00-03','pix','paid'),
    ('012f4d38-2b65-5f2c-9ad8-9225ca0f0554','582217c1-836e-4828-a6f2-e2f2633ee060',3,'anuidade',125.00,125.00,'2018-08-31','2018-08-31 12:00:00-03','pix','paid'),
    ('e4fc837c-adb4-5c3f-ba56-34aa2dd9eab2','582217c1-836e-4828-a6f2-e2f2633ee060',4,'anuidade',125.00,125.00,'2018-11-30','2018-11-30 12:00:00-03','pix','paid'),
    ('aef32420-f61e-5220-ba49-20d780f71cfb','9ef05b7f-dec6-40b7-a156-4da4e3467a94',1,'anuidade',130.46,130.46,'2018-02-28','2018-02-28 12:00:00-03','pix','paid'),
    ('0321ee17-88ac-5f2a-afa4-f8fcac1d0958','9ef05b7f-dec6-40b7-a156-4da4e3467a94',2,'anuidade',125.00,125.00,'2018-05-31','2018-05-31 12:00:00-03','pix','paid'),
    ('eabee85e-7613-507f-8647-26cd2561fb6f','9ef05b7f-dec6-40b7-a156-4da4e3467a94',3,'anuidade',147.26,147.26,'2018-08-31','2018-08-31 12:00:00-03','pix','paid'),
    ('a6f3664b-87b6-56bf-b0af-337d866a3d0a','9ef05b7f-dec6-40b7-a156-4da4e3467a94',4,'anuidade',132.98,132.98,'2018-11-30','2018-12-31 12:00:00-03','pix','paid'),
    ('5bb5f19b-e362-5ae9-aa5e-63827e581415','66f767d4-ad54-49d9-9838-4dc83ea584e2',1,'anuidade',240.00,240.00,'2018-02-28','2018-06-30 12:00:00-03','pix','paid'),
    ('2563a937-e008-5927-be24-206ff8e18f52','66f767d4-ad54-49d9-9838-4dc83ea584e2',2,'anuidade',125.00,125.00,'2018-05-31','2018-10-31 12:00:00-03','dinheiro','paid'),
    ('0308aee6-9c83-5fd7-b432-55b0cd5dbe7f','66f767d4-ad54-49d9-9838-4dc83ea584e2',3,'anuidade',125.00,125.00,'2018-08-31','2018-12-31 12:00:00-03','credito_cbkt','paid'),
    ('ae80eba6-a13e-5d69-be17-b2d4537b96ab','794d63bf-ecd0-426e-9870-369cb2a8760a',1,'anuidade',125.00,125.00,'2018-02-28','2018-02-28 12:00:00-03','pix','paid'),
    ('9a36a1de-d160-546c-8529-7c60f88a5801','794d63bf-ecd0-426e-9870-369cb2a8760a',2,'anuidade',125.00,125.00,'2018-05-31','2018-05-31 12:00:00-03','pix','paid'),
    ('d43bd865-8e26-591f-ae1c-e2fa4366bf58','794d63bf-ecd0-426e-9870-369cb2a8760a',3,'anuidade',125.00,125.00,'2018-08-31','2018-08-31 12:00:00-03','pix','paid'),
    ('bb843caf-fb2e-5071-b6fc-31403b5cc12b','794d63bf-ecd0-426e-9870-369cb2a8760a',4,'anuidade',125.00,125.00,'2018-11-30','2018-11-30 12:00:00-03','pix','paid'),
    ('dae35216-3821-5980-9412-adb995b67982','9d63c6ea-29e4-4217-b339-eecbd9bd743e',1,'anuidade',125.00,125.00,'2018-02-28','2018-02-28 12:00:00-03','pix','paid'),
    ('c81217b9-bb45-520c-b804-b06ac12fd796','9d63c6ea-29e4-4217-b339-eecbd9bd743e',2,'anuidade',125.00,125.00,'2018-05-31','2018-06-30 12:00:00-03','pix','paid'),
    ('64869bb9-2369-555f-8322-a643c72a5efd','9d63c6ea-29e4-4217-b339-eecbd9bd743e',3,'anuidade',125.00,125.00,'2018-08-31','2018-09-30 12:00:00-03','pix','paid'),
    ('330d5ebb-2ef7-5c1b-8ad6-dc9e8e1f2bc0','9d63c6ea-29e4-4217-b339-eecbd9bd743e',4,'anuidade',125.00,125.00,'2018-11-30','2018-11-30 12:00:00-03','pix','paid'),
    ('7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',1,'anuidade',1044.00,1044.00,'2018-05-31','2018-12-31 12:00:00-03','pix','paid'),
    ('abfcf102-53d3-56b4-a354-2d896ffde2b3','a2dd5311-47d6-51d1-aa0d-6944e4a2a83b',1,'anuidade',430.00,430.00,'2018-05-31','2018-06-30 12:00:00-03','pix','paid'),
    ('a61a0d15-c6f6-5f5d-bb26-599f0803ba6f','33103410-96b7-4579-9a72-7c948ffdbcf5',1,'anuidade',125.00,125.00,'2018-02-28','2018-11-30 12:00:00-03','pix','paid'),
    ('5dc86306-bca9-5baa-b1da-22f2e50ba3b2','33103410-96b7-4579-9a72-7c948ffdbcf5',2,'anuidade',125.00,125.00,'2018-05-31','2018-12-31 12:00:00-03','pix','paid'),
    ('849ea5a8-cb21-52fd-a1e1-007d570d282d','33103410-96b7-4579-9a72-7c948ffdbcf5',3,'anuidade',125.00,125.00,'2018-08-31','2018-12-31 12:00:00-03','pix','paid'),
    ('aa96fc2f-0118-5a94-af69-2ca7c8da3e74','33103410-96b7-4579-9a72-7c948ffdbcf5',4,'anuidade',125.00,125.00,'2018-11-30','2018-12-31 12:00:00-03','pix','paid'),
    ('50023f64-ebcc-5f18-a7cf-b297c1a4936b','06a1a5cd-4a00-42ef-89db-42223ad59f50',1,'anuidade',240.00,240.00,'2018-05-31','2018-05-31 12:00:00-03','pix','paid'),
    ('0bfd7fbd-d4fc-541e-9683-be43f7d4b916','06a1a5cd-4a00-42ef-89db-42223ad59f50',2,'anuidade',240.00,240.00,'2018-11-30','2018-11-30 12:00:00-03','pix','paid'),
    ('d0994c29-08f8-5ab7-a0a1-6a5756aa84e3','34399973-14e6-47ee-af96-31720975b3a0',1,'anuidade',430.00,430.00,'2018-05-31','2018-06-30 12:00:00-03','credito_cbkt','paid'),
    ('b495e757-9fb4-5d54-b729-b908e76b4689','1d9ceec1-6f5f-445a-aefa-5cbc53bf0d60',1,'anuidade',240.00,240.00,'2018-05-31','2018-07-31 12:00:00-03','pix','paid'),
    ('608af0d3-0b3d-51c6-b592-9688102fbaec','4b8afba1-b0c8-54e1-bcb7-54262e585acb',1,'anuidade',225.00,225.00,'2019-05-31','2019-10-31 12:00:00-03',NULL,'paid'),
    ('39b01a61-6a57-5ae2-85e4-b25274db928b','00570113-cd26-43ba-808c-dff1c8d691b4',1,'anuidade',450.00,450.00,'2019-05-31','2019-07-31 12:00:00-03','pix','paid'),
    ('60cb9ef4-6131-59d2-a55f-485bfe471a75','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',1,'anuidade',130.00,130.00,'2019-02-28','2019-05-31 12:00:00-03','pix','paid'),
    ('754c83bf-cf96-5535-80f7-3ff4b3744528','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',2,'anuidade',130.00,130.00,'2019-05-31','2019-05-31 12:00:00-03','pix','paid'),
    ('5ee827c0-b807-5135-8d42-d89a9e9a5725','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',3,'anuidade',130.00,130.00,'2019-08-31','2019-08-31 12:00:00-03','pix','paid'),
    ('d5e7273b-6432-5d06-9ae5-8fa3aa51b7a3','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',4,'anuidade',130.00,130.00,'2019-11-30','2019-12-31 12:00:00-03','dinheiro','paid'),
    ('1926d6ef-8d57-55be-a180-d0bcfd66e07c','967e2297-3c06-432d-ab50-52a8386ce043',0,'filiacao',180.00,180.00,'2019-01-31','2019-01-31 12:00:00-03','pix','paid'),
    ('576bdde5-143f-598a-ac92-85c4ccb627b9','967e2297-3c06-432d-ab50-52a8386ce043',1,'anuidade',450.00,450.00,'2019-05-31','2019-01-31 12:00:00-03','pix','paid'),
    ('fa605088-e01b-5278-9dbb-fc2735b2f41d','4b673e7d-e1af-4906-b459-43ff2fc82c76',0,'filiacao',150.00,150.00,'2019-05-31','2019-05-31 12:00:00-03','pix','paid'),
    ('bf66ed2f-4a44-5018-981c-4168d280657e','4b673e7d-e1af-4906-b459-43ff2fc82c76',1,'anuidade',130.00,130.00,'2019-02-28','2019-02-28 12:00:00-03','pix','paid'),
    ('346c7834-28c2-5855-b18e-eaacad0eab72','4b673e7d-e1af-4906-b459-43ff2fc82c76',2,'anuidade',130.00,130.00,'2019-05-31','2019-05-31 12:00:00-03','pix','paid'),
    ('d827b12e-734b-517d-bf30-04c10536516f','4b673e7d-e1af-4906-b459-43ff2fc82c76',3,'anuidade',130.00,130.00,'2019-08-31','2019-09-30 12:00:00-03','pix','paid'),
    ('345db690-b660-5c4c-8dd2-6ea9e109efcd','4b673e7d-e1af-4906-b459-43ff2fc82c76',4,'anuidade',130.00,130.00,'2019-11-30','2019-11-30 12:00:00-03','pix','paid'),
    ('43083084-a0c5-550e-bae0-6a29ffe8d9b0','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',1,'anuidade',130.00,130.00,'2019-02-28','2019-02-28 12:00:00-03','pix','paid'),
    ('bf0554d9-f2a1-5a04-96e7-45af73d9732f','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',2,'anuidade',130.00,130.00,'2019-05-31','2019-06-30 12:00:00-03','pix','paid'),
    ('e02167cb-2174-5396-9240-94eee5c9b258','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',3,'anuidade',130.00,130.00,'2019-08-31','2019-06-30 12:00:00-03','pix','paid'),
    ('15a9d7b1-9826-5aa4-b777-92a929d97a68','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',4,'anuidade',130.00,130.00,'2019-11-30','2019-11-30 12:00:00-03','pix','paid'),
    ('b88ffa87-2e96-568f-afe5-be57e5b3991c','cf290543-3e2e-595c-a295-4425e95a1e79',1,'anuidade',130.00,130.00,'2019-02-28','2019-01-31 12:00:00-03',NULL,'paid'),
    ('8e531154-19ad-5d33-9768-e8bf90edf510','cf290543-3e2e-595c-a295-4425e95a1e79',2,'anuidade',130.00,130.00,'2019-05-31','2019-05-31 12:00:00-03',NULL,'paid'),
    ('b934e49c-de02-5d1b-ab7e-6bcd6e4d52e3','cf290543-3e2e-595c-a295-4425e95a1e79',3,'anuidade',130.00,130.00,'2019-08-31','2019-09-30 12:00:00-03','pix','paid'),
    ('7c76c4ae-2c31-54f4-85d4-a21200b66461','cf290543-3e2e-595c-a295-4425e95a1e79',4,'anuidade',130.00,130.00,'2019-11-30','2019-12-31 12:00:00-03','dinheiro','paid'),
    ('60d47994-4817-52c9-bc21-56f7774a49b1','dfe94ce2-0d18-466a-aadb-3c96172b73da',1,'anuidade',130.00,130.00,'2019-02-28','2019-06-30 12:00:00-03','dinheiro','paid'),
    ('2a9f5a04-469d-540b-b3b5-41d94e2ca6de','dfe94ce2-0d18-466a-aadb-3c96172b73da',2,'anuidade',130.00,130.00,'2019-05-31','2019-06-30 12:00:00-03','dinheiro','paid'),
    ('eaafe694-d0c0-530d-ae28-da5b2a3716d1','dfe94ce2-0d18-466a-aadb-3c96172b73da',3,'anuidade',130.00,130.00,'2019-08-31','2019-09-30 12:00:00-03','pix','paid'),
    ('ce4c4cc5-3892-5196-a2c6-32b4fe050b58','dfe94ce2-0d18-466a-aadb-3c96172b73da',4,'anuidade',130.00,130.00,'2019-11-30','2019-12-31 12:00:00-03','pix','paid'),
    ('71eecc64-c9c2-5dee-904a-48520138c391','25828459-1dd5-4999-8d1f-e96bb7a34523',1,'anuidade',450.80,450.80,'2019-05-31','2019-04-30 12:00:00-03','credito_cbkt','paid'),
    ('ff2b1f1e-5c44-5524-ae3d-7a7b8a3d3f6b','7aa59cbf-816f-463c-9dfb-010bf046938e',1,'anuidade',130.00,130.00,'2019-02-28','2019-02-28 12:00:00-03','pix','paid'),
    ('90ae468c-172e-5def-b60a-30c7c0e48445','7aa59cbf-816f-463c-9dfb-010bf046938e',2,'anuidade',130.00,130.00,'2019-05-31','2019-05-31 12:00:00-03','pix','paid'),
    ('79f8bff6-3fa5-5588-997a-e4a401bf0db0','7aa59cbf-816f-463c-9dfb-010bf046938e',3,'anuidade',130.00,130.00,'2019-08-31','2019-12-31 12:00:00-03','pix','paid'),
    ('347bbdcf-c03b-51b6-a2b5-1ad51a933086','7aa59cbf-816f-463c-9dfb-010bf046938e',4,'anuidade',130.00,130.00,'2019-11-30','2019-12-31 12:00:00-03','pix','paid'),
    ('44df89d5-9a06-5f2f-a249-6ce78f71996a','b6d664f5-6811-4538-92d4-de7213a87cb3',1,'anuidade',130.00,130.00,'2019-02-28','2019-02-28 12:00:00-03','pix','paid'),
    ('776334fa-df8f-5939-95a8-4b0deee78a61','b6d664f5-6811-4538-92d4-de7213a87cb3',2,'anuidade',130.00,130.00,'2019-05-31','2019-05-31 12:00:00-03','pix','paid'),
    ('064e48d2-f66f-5563-b46e-7811d482a695','b6d664f5-6811-4538-92d4-de7213a87cb3',3,'anuidade',130.00,130.00,'2019-08-31','2019-08-31 12:00:00-03','pix','paid'),
    ('38514225-864a-5923-a708-7cb6d40eea53','b6d664f5-6811-4538-92d4-de7213a87cb3',4,'anuidade',130.00,130.00,'2019-11-30','2019-11-30 12:00:00-03','pix','paid'),
    ('dadc4a72-fd55-56ed-9eb1-0fe43e92b16f','442fdcbb-3a0f-474e-8715-6668487d2a83',1,'anuidade',450.00,450.00,'2020-05-31','2020-09-30 12:00:00-03','dinheiro','paid'),
    ('89102422-af1c-5ba8-957b-7817074f1508','5023e599-7591-46be-a274-7b8d8faf9e2c',1,'anuidade',450.00,450.00,'2020-05-31','2021-02-28 12:00:00-03','outro','paid'),
    ('5c9f1bff-f8ac-51a8-8f0c-93aa9f1fe734','97d06e18-6b27-41ef-90dd-97fc3532c39c',1,'anuidade',130.00,130.00,'2020-02-29','2020-02-28 12:00:00-03','credito_cbkt','paid'),
    ('bc6a4793-83e1-53f7-91dc-89025c52d43f','97d06e18-6b27-41ef-90dd-97fc3532c39c',2,'anuidade',130.00,130.00,'2020-05-31','2020-09-30 12:00:00-03','pix','paid'),
    ('71faeda3-0f16-54f4-9a63-184de77b4bee','97d06e18-6b27-41ef-90dd-97fc3532c39c',3,'anuidade',130.00,130.00,'2020-08-31','2020-09-30 12:00:00-03','pix','paid'),
    ('b1c0f6c2-88d3-56cc-a1a5-52db7a98c26d','fd9305a6-3844-4887-985f-bfc22d06e712',1,'anuidade',130.00,130.00,'2020-02-29','2020-02-29 12:00:00-03','pix','paid'),
    ('9250a48f-b116-5842-b584-ee66ef1062d5','fd9305a6-3844-4887-985f-bfc22d06e712',2,'anuidade',130.00,130.00,'2020-05-31','2020-05-31 12:00:00-03','pix','paid'),
    ('8cb767c8-1352-5656-ab46-3ba417921f16','18407eb5-3a56-428e-a847-4f2eed2d01bb',1,'anuidade',130.00,130.00,'2020-02-29','2020-03-30 12:00:00-03','boleto','paid'),
    ('89b2bd25-f471-52ef-bc44-7d34172f7dfe','18407eb5-3a56-428e-a847-4f2eed2d01bb',2,'anuidade',130.00,130.00,'2020-05-31','2020-06-30 12:00:00-03','pix','paid'),
    ('347516e1-dcf2-56df-b53e-fca95e193125','18407eb5-3a56-428e-a847-4f2eed2d01bb',3,'anuidade',130.00,130.00,'2020-08-31','2020-08-31 12:00:00-03','pix','paid'),
    ('3013ba93-3127-509d-8ce8-a36f59889b34','18407eb5-3a56-428e-a847-4f2eed2d01bb',4,'anuidade',130.00,130.00,'2020-11-30','2020-11-30 12:00:00-03','pix','paid'),
    ('86b53e26-04ef-57ad-b647-7d7f5d2ef1ee','b4f1cea2-dac4-4802-a211-f1b4da3123f4',1,'anuidade',130.00,130.00,'2020-02-29','2020-02-28 12:00:00-03','credito_exame','paid'),
    ('017caa1f-35d3-56e6-b55d-a254df98d8f6','b4f1cea2-dac4-4802-a211-f1b4da3123f4',2,'anuidade',280.00,280.00,'2020-05-31','2020-11-30 12:00:00-03','pix','paid'),
    ('e2c2d24d-ac73-5015-bd33-4c41b783e3a6','39cfeb23-3b86-4e2c-9ca5-5822c83e66f4',1,'anuidade',130.00,130.00,'2020-02-29','2020-02-28 12:00:00-03','pix','paid'),
    ('f6f154c9-39c8-5334-92a8-bac1201e5bae','39cfeb23-3b86-4e2c-9ca5-5822c83e66f4',2,'anuidade',130.00,130.00,'2020-05-31','2020-05-31 12:00:00-03','pix','paid'),
    ('3f77f356-a0ae-5d10-9087-65bbe05903ae','39cfeb23-3b86-4e2c-9ca5-5822c83e66f4',3,'anuidade',130.00,130.00,'2020-08-31','2020-08-31 12:00:00-03','pix','paid'),
    ('f14d63de-3933-5b58-895c-b0379e99300d','e67f1599-04fd-4f1d-abfe-524982de0da6',1,'anuidade',400.00,400.00,'2020-05-31','2020-09-30 12:00:00-03','pix','paid'),
    ('f2da236c-86ad-591f-835c-ae102501c959','af429fe5-28ae-47dc-a311-855b334ea844',1,'anuidade',130.00,130.00,'2020-02-29','2020-02-28 12:00:00-03','pix','paid'),
    ('8925a3e3-00ee-58a5-b8f9-7d1f8fdbc56a','af429fe5-28ae-47dc-a311-855b334ea844',2,'anuidade',130.00,130.00,'2020-08-31','2020-12-31 12:00:00-03','pix','paid'),
    ('3f5113cd-ba70-58d0-a7f7-2b1b669ea576','af429fe5-28ae-47dc-a311-855b334ea844',3,'anuidade',130.00,130.00,'2020-11-30','2020-12-31 12:00:00-03','pix','paid'),
    ('fc2aed18-ab12-5dfe-b5c6-4e43edec8f0c','b3380551-3a25-4c19-90dd-d8bac9805d9f',1,'anuidade',250.00,250.00,'2021-05-31','2021-07-31 12:00:00-03','credito_exame','paid'),
    ('ec04999c-751b-56ed-ac01-7ab6ec532933','b3380551-3a25-4c19-90dd-d8bac9805d9f',2,'anuidade',250.00,250.00,'2021-11-30','2021-12-31 12:00:00-03','dinheiro','paid'),
    ('8ab66178-ff01-5b40-9227-77ad392f18ff','9637f251-e900-420d-8e85-b28467810d52',1,'anuidade',250.00,250.00,'2021-05-31','2021-07-31 12:00:00-03','credito_exame','paid'),
    ('3aa2764c-a951-59d7-b4c0-3549b4e84574','9637f251-e900-420d-8e85-b28467810d52',2,'anuidade',250.00,250.00,'2021-11-30','2021-11-30 12:00:00-03','credito_exame','paid'),
    ('de4e33e0-7fef-5e6e-9510-3ffa4fec2428','6039b798-90ee-447d-97a4-b6fe0e131f8d',1,'anuidade',150.00,150.00,'2022-02-28','2022-02-28 12:00:00-03','pix','paid'),
    ('cffae493-6c26-5ce8-b09a-32ca4dd30767','6039b798-90ee-447d-97a4-b6fe0e131f8d',2,'anuidade',188.00,188.00,'2022-05-31','2022-03-30 12:00:00-03','pix','paid'),
    ('7d3e6139-a67b-5341-9709-6cb97d63546a','6039b798-90ee-447d-97a4-b6fe0e131f8d',3,'anuidade',188.00,188.00,'2022-08-31','2022-11-30 12:00:00-03','pix','paid'),
    ('f17e1a46-eb30-5f96-8105-3042b80bc934','922fd55a-ce92-4895-882c-20c4c76c9fbf',1,'anuidade',450.00,450.00,'2022-05-31','2022-05-31 12:00:00-03','credito_exame','paid'),
    ('9997b247-6667-519f-bc00-28095da091ee','1eeebba1-9489-4b6c-ba77-c27f89f80793',1,'anuidade',130.00,130.00,'2022-02-28','2022-11-30 12:00:00-03','pix','paid'),
    ('160d026c-aed0-50d2-874d-7bf82d33fb13','1eeebba1-9489-4b6c-ba77-c27f89f80793',2,'anuidade',130.00,130.00,'2022-05-31','2022-11-30 12:00:00-03','pix','paid'),
    ('d79cce7c-f0b6-5ae4-bcab-c6ab01e5b2a7','1eeebba1-9489-4b6c-ba77-c27f89f80793',3,'anuidade',130.00,130.00,'2022-08-31','2022-11-30 12:00:00-03','pix','paid'),
    ('b73d6cc7-c9cf-591a-b2ab-e9b2c596c51d','1eeebba1-9489-4b6c-ba77-c27f89f80793',4,'anuidade',130.00,130.00,'2022-11-30','2022-11-30 12:00:00-03','pix','paid'),
    ('915043e0-8821-5c84-a110-cafea859e314','5fb79045-1a15-4b6d-a1cd-57b1f9a3784c',1,'anuidade',450.00,450.00,'2022-05-31','2022-07-31 12:00:00-03','pix','paid'),
    ('2deec74c-3c9b-5b39-a9e0-4f325a34f90f','4116f847-0278-450f-9f42-1ec949b1fec4',1,'anuidade',130.00,130.00,'2022-02-28','2022-02-28 12:00:00-03','pix','paid'),
    ('1b66ca03-7d84-5a90-a608-8a12b5a80dac','4116f847-0278-450f-9f42-1ec949b1fec4',2,'anuidade',130.00,130.00,'2022-05-31','2022-06-30 12:00:00-03','pix','paid'),
    ('37c4ed6c-951c-540e-963e-f946269c90b6','4116f847-0278-450f-9f42-1ec949b1fec4',3,'anuidade',130.00,130.00,'2022-08-31','2022-09-30 12:00:00-03','pix','paid'),
    ('62387a46-b646-5171-aaa5-b107896cd09f','4116f847-0278-450f-9f42-1ec949b1fec4',4,'anuidade',130.00,130.00,'2022-11-30','2022-12-31 12:00:00-03','pix','paid'),
    ('c26229f4-a793-52fe-8a04-700b10a1a474','41884f9a-cee1-4e4d-a44d-e30e9afc0e8c',1,'anuidade',480.00,480.00,'2023-05-31','2023-02-28 12:00:00-03','credito_exame','paid'),
    ('0abe66a4-9024-5b62-8110-53c10218f859','e9691e6c-c007-48c8-892f-02d56e35d856',1,'anuidade',480.00,480.00,'2023-05-31','2023-05-31 12:00:00-03','boleto','paid'),
    ('5c57f829-b094-5a66-ab87-4f0ddf0e7994','d1a2d469-5cd7-4aae-a960-cfade2207f40',1,'anuidade',280.00,280.00,'2023-02-28','2023-03-31 12:00:00-03','pix','paid'),
    ('8670f5ea-7106-5a6f-9340-6a0867c24a4a','d1a2d469-5cd7-4aae-a960-cfade2207f40',2,'anuidade',39.45,39.45,'2023-05-31','2023-05-31 12:00:00-03','dinheiro','paid'),
    ('440eeca9-32a8-52cd-8fd6-ae638eb61d58','d1a2d469-5cd7-4aae-a960-cfade2207f40',3,'anuidade',280.01,280.01,'2023-08-31','2023-08-31 12:00:00-03','pix','paid'),
    ('10ec882f-e2e8-5737-a840-b2bc9a86adfc','969156ac-f108-4a74-a5de-ed11d6437c21',1,'anuidade',265.00,265.00,'2023-05-31','2023-09-30 12:00:00-03','credito_exame','paid'),
    ('60d23c73-01aa-5b6e-b84b-03aed4803d6d','969156ac-f108-4a74-a5de-ed11d6437c21',2,'anuidade',265.00,265.00,'2023-11-30','2023-09-30 12:00:00-03','credito_cbkt','paid'),
    ('e36809da-bd8e-524b-aa0a-9f484c75cb24','c062a4ee-aa9a-47fe-afce-cde499581bf6',1,'anuidade',480.00,480.00,'2023-05-31','2023-08-31 12:00:00-03','credito_exame','paid'),
    ('b1e79ed5-3e42-5f42-8a2a-ac80bcd0ffcb','f763c512-d1eb-43f9-a9c4-001f100e2b44',1,'anuidade',480.00,480.00,'2023-05-31','2023-09-30 12:00:00-03','dinheiro','paid'),
    ('f76b3919-f10e-5655-8e51-b1755d73a772','5ef42424-ae75-475f-9a06-056ff57aeb2e',1,'anuidade',140.00,140.00,'2023-02-28','2023-02-28 12:00:00-03','pix','paid'),
    ('e328652e-b2a3-5756-8414-eb4be401f249','5ef42424-ae75-475f-9a06-056ff57aeb2e',2,'anuidade',140.00,140.00,'2023-05-31','2023-03-30 12:00:00-03','pix','paid'),
    ('a60b5950-4690-52ba-a2d9-bd71477a18d1','5ef42424-ae75-475f-9a06-056ff57aeb2e',3,'anuidade',140.00,140.00,'2023-08-31','2023-09-30 12:00:00-03','dinheiro','paid'),
    ('3fd085c9-3ecc-509d-bd23-0cf08ae265e0','5ef42424-ae75-475f-9a06-056ff57aeb2e',4,'anuidade',140.00,140.00,'2023-11-30','2023-09-30 12:00:00-03','dinheiro','paid'),
    ('7676c2aa-ce44-5a96-a621-66cc6dbc6b5a','83d56c0e-72ca-4124-a1d0-6392fd077b2d',1,'anuidade',140.00,140.00,'2023-02-28','2023-03-30 12:00:00-03','pix','paid'),
    ('8f865b74-537e-54d5-a097-ec2b903a03f5','83d56c0e-72ca-4124-a1d0-6392fd077b2d',2,'anuidade',140.00,140.00,'2023-05-31','2023-05-31 12:00:00-03','pix','paid'),
    ('5eda0d06-d19d-5780-bd75-70617150f1eb','83d56c0e-72ca-4124-a1d0-6392fd077b2d',3,'anuidade',140.00,140.00,'2023-08-31','2023-09-30 12:00:00-03','pix','paid'),
    ('891f3984-c356-58ef-b01c-1775e64a20a4','83d56c0e-72ca-4124-a1d0-6392fd077b2d',4,'anuidade',140.00,140.00,'2023-11-30','2023-12-30 12:00:00-03','pix','paid'),
    ('e686f18d-f169-5ff4-b65a-a571136d43ca','77a5695c-215a-49e3-986d-51aa18dd4778',1,'anuidade',500.00,500.00,'2024-05-31','2024-02-28 12:00:00-03','credito_exame','paid'),
    ('a0a92fdd-cb69-598b-baef-b0bb3c443f2e','e2b758c8-9d25-458f-bb93-39ef02500100',1,'anuidade',150.00,150.00,'2024-02-29','2024-04-30 12:00:00-03','pix','paid'),
    ('5069d6b3-a6a1-5342-bddf-a50515c09c53','e2b758c8-9d25-458f-bb93-39ef02500100',2,'anuidade',150.00,150.00,'2024-05-31','2024-05-31 12:00:00-03','pix','paid'),
    ('ee5d8def-bf72-5acc-a505-d9d31e139f76','e2b758c8-9d25-458f-bb93-39ef02500100',3,'anuidade',150.00,150.00,'2024-08-31','2024-10-31 12:00:00-03','pix','paid'),
    ('591718c1-ec20-5780-ba48-058e1bd4ace6','e2b758c8-9d25-458f-bb93-39ef02500100',4,'anuidade',150.00,150.00,'2024-11-30','2024-10-31 12:00:00-03','pix','paid'),
    ('35e7d56b-645b-5e83-aa54-511d2239caf6','9340f9f8-7c7a-4ed2-a37d-9d14ba85269d',1,'anuidade',280.00,280.00,'2024-05-31','2024-06-30 12:00:00-03','pix','paid'),
    ('85c237cd-bfa8-5b42-935b-37e466ccd4a2','9340f9f8-7c7a-4ed2-a37d-9d14ba85269d',2,'anuidade',280.00,280.00,'2024-11-30','2024-12-30 12:00:00-03','pix','paid'),
    ('3caa65a3-6d4c-5d2d-bc3c-d748a0bd2195','3abc01c3-3f3b-4d4b-8d60-2102300118d1',1,'anuidade',500.00,500.00,'2024-05-31','2024-05-31 12:00:00-03','boleto','paid'),
    ('7628d622-577c-58e9-9287-108c16e0ebab','958d5489-ce57-4805-ac99-175f87f691c0',1,'anuidade',280.00,280.00,'2024-05-31','2024-06-30 12:00:00-03','pix','paid'),
    ('2e3c8a44-8dd7-54fc-a33b-8de95a59c6d9','958d5489-ce57-4805-ac99-175f87f691c0',2,'anuidade',280.00,280.00,'2024-11-30','2024-11-30 12:00:00-03','pix','paid'),
    ('919e041f-9c39-547e-8387-9a282356d6aa','a5c56f0c-9c19-49de-880e-db70b7c283c1',1,'anuidade',500.00,500.00,'2024-05-31','2024-05-31 12:00:00-03','credito_exame','paid'),
    ('eb551a3a-d0b4-5e90-9704-0bae7f6f94f1','a5288db5-c2c4-4657-817e-925ecb2d6135',0,'filiacao',195.00,195.00,'2024-09-30','2024-09-30 12:00:00-03','pix','paid'),
    ('11933861-cc07-582c-b6d8-14f55efaf794','a5288db5-c2c4-4657-817e-925ecb2d6135',1,'anuidade',125.00,125.00,'2024-11-30','2024-10-31 12:00:00-03','pix','paid'),
    ('072ab9e0-7288-586c-a166-7a408d8f0da1','9ae079b7-2af2-4745-968f-6348bd4ed68e',1,'anuidade',500.00,500.00,'2024-05-31','2024-07-30 12:00:00-03','pix','paid'),
    ('64f89767-a450-5233-b7e4-046e72a71d30','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',1,'anuidade',150.00,150.00,'2024-02-29','2024-02-28 12:00:00-03','pix','paid'),
    ('fa6306e6-e2bc-5896-8542-29ad7f1fab3b','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',2,'anuidade',150.00,150.00,'2024-05-31','2024-06-30 12:00:00-03','pix','paid'),
    ('92ffe4a7-7c3a-5290-b70b-f1b9de176e1b','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',3,'anuidade',150.00,150.00,'2024-08-31','2024-09-30 12:00:00-03','pix','paid'),
    ('59835dbc-956e-5c72-9d8d-c52576afac76','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',4,'anuidade',150.00,150.00,'2024-11-30','2024-11-30 12:00:00-03','pix','paid'),
    ('ec592b8e-8d76-5338-9c3d-8440244f6289','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',1,'anuidade',150.00,150.00,'2024-02-29','2024-02-28 12:00:00-03','pix','paid'),
    ('57781756-0fe9-5c93-8197-6f8ccdc4f684','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',2,'anuidade',150.00,150.00,'2024-05-31','2024-06-30 12:00:00-03','pix','paid'),
    ('167f0e66-4e33-5eb2-b589-3f8987c45642','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',3,'anuidade',150.00,150.00,'2024-08-31','2024-12-30 12:00:00-03','pix','paid'),
    ('4c5a706f-f0db-5d4f-bc7a-e6f6984c9825','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',4,'anuidade',150.00,150.00,'2024-11-30','2024-12-30 12:00:00-03','pix','paid'),
    ('cc963a35-93e0-5332-bf89-2ff33fb6bc81','05f8c3b1-05c2-4fdd-8569-3ca891c72775',1,'anuidade',280.00,280.00,'2025-05-31','2025-06-30 12:00:00-03','pix','paid'),
    ('97e1c009-9610-5ae2-b902-f0867f03471b','05f8c3b1-05c2-4fdd-8569-3ca891c72775',2,'anuidade',280.00,280.00,'2025-11-30','2025-12-30 12:00:00-03','pix','paid'),
    ('9592bea2-1334-57ba-9482-f96ce90a5b83','e9f6bd2c-a3d9-44d4-8c32-9690b5fbe7bc',1,'anuidade',640.00,640.00,'2025-05-31','2025-07-30 12:00:00-03','pix','paid'),
    ('af4baeb8-f328-5e1d-afc9-9f7c1250069a','1d77b8f5-49e3-4208-b112-51f580a13425',1,'anuidade',310.00,310.00,'2025-05-31','2025-02-28 12:00:00-03','credito_exame','paid'),
    ('9e7973dd-3f85-545b-9ce5-39c13a0afa9f','1d77b8f5-49e3-4208-b112-51f580a13425',2,'anuidade',200.00,200.00,'2025-11-30','2025-03-30 12:00:00-03','pix','paid'),
    ('4c7dc4f7-4268-5e47-bd9f-58c343536e85','3516edcd-41a5-4ea7-bd14-e7a48360a2fd',1,'anuidade',500.00,500.00,'2025-05-31','2025-05-31 12:00:00-03','boleto','paid'),
    ('2f9e8e03-2419-5076-82e5-427d24acc683','66d25ed8-c18d-44e3-a4e6-8f1e4b0f3c54',1,'anuidade',495.00,495.00,'2025-05-31','2025-03-30 12:00:00-03','pix','paid'),
    ('9e330e0c-ec86-5d3d-b971-0d3176efbf97','831fe3c4-0e6a-4360-beb9-f1537e09aecc',1,'anuidade',255.00,255.00,'2025-05-31','2025-02-28 12:00:00-03','pix','paid'),
    ('ef313ba0-e373-51b1-80f8-0f3a6ec099c7','831fe3c4-0e6a-4360-beb9-f1537e09aecc',2,'anuidade',245.00,245.00,'2025-11-30','2025-09-30 12:00:00-03','pix','paid'),
    ('0405114d-d8f0-56b2-bc73-25f118bd6050','12f7c790-9b58-4350-8683-7a5533a73384',1,'anuidade',500.00,500.00,'2025-05-31','2025-06-30 12:00:00-03','pix','paid'),
    ('31e5a56e-37c7-5a1a-ae33-642d0244a313','6ac6d03a-4b96-4e38-828d-001de6990860',1,'anuidade',500.00,500.00,'2025-05-31','2025-06-30 12:00:00-03','boleto','paid'),
    ('8917af59-3f94-5aeb-ba44-255426d608fa','94dbd8ac-27e8-4805-ace6-2c7aef1bbc8d',1,'anuidade',280.00,280.00,'2025-05-31','2025-07-30 12:00:00-03','pix','paid'),
    ('e57edd29-7613-592a-bf1a-4057ee9ef447','94dbd8ac-27e8-4805-ace6-2c7aef1bbc8d',2,'anuidade',280.00,280.00,'2025-11-30','2025-07-30 12:00:00-03','pix','paid'),
    ('5f00ff87-30fe-50a6-9d6f-0596890ae8f2','7971ae36-8788-4813-9949-a1041cd3fff0',1,'anuidade',150.00,150.00,'2025-02-28','2025-02-28 12:00:00-03','pix','paid'),
    ('bccf2de3-cd5a-50b5-88bd-5009a70e0c84','7971ae36-8788-4813-9949-a1041cd3fff0',2,'anuidade',150.00,150.00,'2025-05-31','2025-06-30 12:00:00-03','pix','paid'),
    ('65d80428-abc5-529f-9623-d0e8e0e0f033','7971ae36-8788-4813-9949-a1041cd3fff0',3,'anuidade',150.00,150.00,'2025-08-31','2025-09-30 12:00:00-03','pix','paid'),
    ('ed8920cf-a64e-5e64-b833-30ae3001de63','7971ae36-8788-4813-9949-a1041cd3fff0',4,'anuidade',150.00,150.00,'2025-11-30','2025-12-30 12:00:00-03','pix','paid');

INSERT INTO _m344_led VALUES
    ('a6490f66-4596-520e-8f08-2ec823ccd21c'::uuid,'04b9782c-aed9-5ea1-bbf7-fc589a21c8a0'::uuid,'c46f50d0-2d06-4190-886a-f3a8b34e55fb'::uuid,125.00::numeric,'2017-02-28 12:00:00-03'::timestamptz,'pix'::text),
    ('d3c9c8ae-9dfa-5d57-ab86-b976f3c3476b','46eb6cef-0f85-59b4-9925-94afd74e45cc','c46f50d0-2d06-4190-886a-f3a8b34e55fb',125.00,'2017-05-31 12:00:00-03','pix'),
    ('acf8a8f0-dec0-5ac8-b13f-3b16052ec59b','8e276639-4a49-5b71-9142-05ee22e46729','c46f50d0-2d06-4190-886a-f3a8b34e55fb',125.00,'2017-08-31 12:00:00-03','pix'),
    ('92ae50f8-4fb1-52b1-8ef7-75cf67b972b0','f48a25f6-45df-59a9-b738-2b1a1cc39a14','c46f50d0-2d06-4190-886a-f3a8b34e55fb',125.00,'2017-11-30 12:00:00-03','pix'),
    ('c7459204-8bbe-5e96-8b98-579dc9bd8d8c','db367ee4-2bdb-56c4-8bd5-c0936a8778db','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',125.00,'2017-02-28 12:00:00-03','pix'),
    ('74a9dc45-02b9-5efa-8492-45d8177d0e17','41956fce-7e32-5421-8b42-2dad6cb13ecb','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',125.00,'2017-05-31 12:00:00-03','pix'),
    ('7db4af5f-05ac-561c-8186-1965d3062d1d','a0273623-5d58-56df-b8da-4673c4e3d83e','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',125.00,'2017-08-31 12:00:00-03','pix'),
    ('0b8b64e8-c267-50a0-b771-2c70b6ffef12','4a0ee290-fea1-5174-9850-35a836be43c5','e9cd9619-0c6c-4bef-a103-2cf3740d15cd',125.00,'2017-11-30 12:00:00-03','pix'),
    ('931d62fe-ecd0-5ca7-ae4a-2b994111ff38','6ece8c67-8577-5218-9540-142e4cad4606','418d7bd5-af90-4b10-a5e1-cfd7fb567559',125.00,'2017-11-30 12:00:00-03','pix'),
    ('536aa921-1949-512d-8d69-9f48e751952b','d4506322-3db9-5a37-b6d5-17d0bba4cbe7','418d7bd5-af90-4b10-a5e1-cfd7fb567559',125.00,'2017-11-30 12:00:00-03','pix'),
    ('03478b62-0883-567b-a30a-083fd4166ca8','03945d91-2481-5b84-a89b-085e78242c8e','418d7bd5-af90-4b10-a5e1-cfd7fb567559',125.00,'2017-11-30 12:00:00-03','pix'),
    ('23786212-fa2a-517e-8af1-2f0a8794d18f','68764c9a-46c5-5202-80fd-e3cd844fcf55','418d7bd5-af90-4b10-a5e1-cfd7fb567559',125.00,'2017-11-30 12:00:00-03','pix'),
    ('36aba59a-3cc3-5d98-aadf-71968934d367','a5ebbed7-5ded-563d-ae8e-b5bca5dca9e7','82a53056-75d5-4956-97c1-965fc6030d46',125.00,'2017-02-28 12:00:00-03','pix'),
    ('0a8054cc-3a96-5f9d-9192-292cc80f2210','d190c86d-61b5-564c-91ad-c59e4b7600b8','82a53056-75d5-4956-97c1-965fc6030d46',125.00,'2017-05-31 12:00:00-03','pix'),
    ('00930a10-5ebb-51d4-8ea6-c5678cb11242','431554ab-1198-57e2-8cd4-8bcf2effc6a7','82a53056-75d5-4956-97c1-965fc6030d46',125.00,'2017-08-31 12:00:00-03','pix'),
    ('3d4bdfae-9982-5a24-ac3a-52242b46ec5a','dd4986e2-72b4-5d94-9cf3-e8ec70691891','82a53056-75d5-4956-97c1-965fc6030d46',125.00,'2017-11-30 12:00:00-03','pix'),
    ('b1191d6a-9ecd-5fcc-89bd-f007ff07434d','22f4928a-d7ba-5b09-9bfe-cb48d139f278','df19d106-3fc9-4f82-820a-daa74b44fe3a',125.00,'2017-02-28 12:00:00-03','pix'),
    ('d49146a9-6122-5bbb-a994-079923e08c34','cbb7b483-c85e-50dd-ba28-890ea6c125d1','df19d106-3fc9-4f82-820a-daa74b44fe3a',125.00,'2017-05-31 12:00:00-03','pix'),
    ('c928079a-ebdf-511a-b90c-caf129a3ca14','ec560a45-4932-534b-b625-5aaf346e4171','df19d106-3fc9-4f82-820a-daa74b44fe3a',127.94,'2017-08-31 12:00:00-03','pix'),
    ('792b9afa-1199-5049-9e7d-9e9f2326a2fa','7f5d9cf7-a67d-5e63-b2d2-57f3a85f347d','df19d106-3fc9-4f82-820a-daa74b44fe3a',125.00,'2017-11-30 12:00:00-03','dinheiro'),
    ('24ef2a45-2a53-5cfd-9586-a18167c7978c','624f3c09-bdf2-51a1-af81-6a36f10e84a1','201da200-ed06-4365-bd73-d8d22b88b3be',125.00,'2017-02-28 12:00:00-03','pix'),
    ('a98c5dc9-25f5-5db6-aad4-d281d8064d1f','cd144ee1-7bcc-5d00-8b47-3afdeca71a34','201da200-ed06-4365-bd73-d8d22b88b3be',125.00,'2017-05-31 12:00:00-03','pix'),
    ('665de8ec-0eb9-5b71-85ee-088798f7b46e','f93e802e-d127-5f3c-81f5-2b8e93095c25','201da200-ed06-4365-bd73-d8d22b88b3be',125.00,'2017-08-31 12:00:00-03','pix'),
    ('de9442ed-c71f-5757-b92e-de5b8b6972aa','37ea5692-f6db-5a1d-8064-02466b14a7e7','201da200-ed06-4365-bd73-d8d22b88b3be',125.00,'2017-11-30 12:00:00-03','pix'),
    ('143c28a1-faee-53cf-898b-a47b1f423cbd','791d1f62-a71c-5ab1-ae52-e6a6549ed535','2975bfb1-5c3e-49ab-ade0-07d820ea3463',125.00,'2017-02-28 12:00:00-03','pix'),
    ('24f4c226-5975-585a-9eeb-7481b2866b54','da55043d-8fd5-5e83-9675-128bb76e5272','2975bfb1-5c3e-49ab-ade0-07d820ea3463',125.00,'2017-05-31 12:00:00-03','pix'),
    ('e7515daa-808e-571a-83fa-abeeb078f788','efab8bdd-93a3-5cb1-8159-2133741a1725','2975bfb1-5c3e-49ab-ade0-07d820ea3463',125.00,'2017-08-31 12:00:00-03','pix'),
    ('2bd80cc4-56b3-5894-9ec8-578b1d0b0b7c','8eab208d-cb8c-53e4-bba0-6cd86143245e','2975bfb1-5c3e-49ab-ade0-07d820ea3463',125.00,'2017-11-30 12:00:00-03','pix'),
    ('445821a4-3928-536a-bcca-c3265ef9d65b','06c3d9a7-ea3e-51a4-b512-c82f82bc183b','0290a134-493e-444a-a0c9-b013037b991e',125.00,'2017-02-28 12:00:00-03','pix'),
    ('059a6fef-ef77-535a-8f19-b63f734afcf0','9fe1818c-4061-54eb-acc2-b01590ecefca','0290a134-493e-444a-a0c9-b013037b991e',125.00,'2017-05-31 12:00:00-03','pix'),
    ('806d435c-2ae1-543f-8296-fffd520a617f','467a42ca-d695-509e-bf3d-50082580ecdb','0290a134-493e-444a-a0c9-b013037b991e',125.00,'2017-08-31 12:00:00-03','dinheiro'),
    ('7d5a2570-d5f8-599a-a2d0-4fedbe111140','1be8905b-6fbf-568b-a9e5-b0f99e069711','0290a134-493e-444a-a0c9-b013037b991e',125.00,'2017-11-30 12:00:00-03','pix'),
    ('dff9c833-23c9-5a76-998b-677fc59914b0','f3bf47ad-4a5a-5ac2-98d6-afe45e69e173','943707e4-dbe3-5ceb-89aa-519f693a2b8e',130.04,'2018-01-31 12:00:00-03',NULL),
    ('801af764-fd5d-57ff-82ba-971236ee9505','42810284-1974-5f17-ad0a-8dc57462ca1f','943707e4-dbe3-5ceb-89aa-519f693a2b8e',128.78,'2018-02-28 12:00:00-03',NULL),
    ('49cc0f0a-8bb9-59cd-ab0b-2df36bfb543b','b215a0cb-3965-5cde-b05b-65fc9740897d','943707e4-dbe3-5ceb-89aa-519f693a2b8e',130.00,'2018-03-31 12:00:00-03',NULL),
    ('bfff3e60-4c91-5ba5-be69-4d66869cdfd5','4ef8b117-03a8-559b-9f54-c5da7a24fa65','943707e4-dbe3-5ceb-89aa-519f693a2b8e',132.00,'2018-04-30 12:00:00-03',NULL),
    ('34845c66-3074-5225-bf17-98a74e3cb32e','c3d1e974-a519-58d1-bef7-d6389d72dde4','af1801bd-9c5e-4e95-8fdb-40b1311c777b',150.00,'2017-06-30 12:00:00-03','dinheiro'),
    ('5b549bd1-cfb1-5bbe-9755-c7f1cba7b27f','825b90fc-73ec-5b51-85b0-6afa0a92e68c','af1801bd-9c5e-4e95-8fdb-40b1311c777b',240.00,'2017-07-31 12:00:00-03','dinheiro'),
    ('bf9ae00a-0516-5562-bf48-0e8860b025dc','8ecaa901-3a48-565f-a5fd-67154f902b3c','39de9cc1-9c03-5536-8129-cfdda192a9d0',240.00,'2017-05-31 12:00:00-03',NULL),
    ('926bca90-4ada-53e4-993a-f9b892bc1d44','12487681-1454-5c5e-a730-e158e0875b12','39de9cc1-9c03-5536-8129-cfdda192a9d0',240.00,'2017-11-30 12:00:00-03',NULL),
    ('4c694de1-d483-522e-b97a-e10087ba2243','524e7e05-2dc5-5413-b6c9-baa0522959a5','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',125.00,'2017-02-28 12:00:00-03','pix'),
    ('26925d4a-7e58-5de5-9cb2-d5e176f6e745','40090bc7-8ac5-5f00-9ccf-446c4f1efb9a','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',125.00,'2017-05-31 12:00:00-03','pix'),
    ('71f6bcfe-6447-55e6-a745-7c2d3da7f56f','221bdc20-28af-59d2-bb65-6539ececf7a1','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',125.00,'2017-08-31 12:00:00-03','pix'),
    ('0de0fe13-a6fd-54c7-99e3-4a8ab74029cc','38d180b9-5eb1-5191-87d4-9a20fbb42017','9bfb406c-a020-4dbe-8a4d-a78f02247dd2',125.00,'2017-10-31 12:00:00-03','pix'),
    ('55bacd53-c00e-588c-a46c-2c97c6615cd7','c0f3394e-c0b8-5901-9351-99ba1614feea','b77bb18d-0c2a-47d9-893e-69995bfb1271',125.00,'2017-02-28 12:00:00-03','pix'),
    ('4404ae61-e305-5075-bfa2-417b50819879','59c35d47-a283-570c-94e1-07c5a186340f','b77bb18d-0c2a-47d9-893e-69995bfb1271',125.00,'2017-05-31 12:00:00-03','pix'),
    ('c9392e2f-a7a3-5f91-949b-f74084f0557d','aceb3f6e-45c9-54ee-98a3-1c070322ae15','b77bb18d-0c2a-47d9-893e-69995bfb1271',125.00,'2017-08-31 12:00:00-03','pix'),
    ('94c0b948-dfe4-50cf-baa0-078e92cfe1e8','0c32b5a6-b6e6-5a20-bd13-ae493a4388b3','b77bb18d-0c2a-47d9-893e-69995bfb1271',125.00,'2017-11-30 12:00:00-03','pix'),
    ('fad6af3b-3bd6-5946-9042-606faafeb262','09aac587-cd39-5c23-8bba-a03110b147dc','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',125.00,'2018-12-31 12:00:00-03','dinheiro'),
    ('ef5cd072-0eb2-5055-b1a3-d94333542c05','4ec1d773-0bfa-5f8b-8b87-ee6213d83e12','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',125.00,'2018-12-31 12:00:00-03','dinheiro'),
    ('2f472cb6-51f5-5aa3-9a7f-c79af5d862a7','ee026593-913d-5844-a91a-5f86a7832a17','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',125.00,'2018-12-31 12:00:00-03','dinheiro'),
    ('b6d7d6cf-eb1d-593a-a59d-b9a65f6d9aa7','8e8d32c7-e928-55f2-b6e0-14261c356f0b','4b7d10ec-b8e6-4f1e-8aac-abc48535c869',125.00,'2018-12-31 12:00:00-03','dinheiro'),
    ('d388d9fa-783d-5346-8afb-e44245bb8923','0c74bbbc-18bc-58cd-8a7c-975e214b93ad','64b7c07d-440d-49da-ba08-40752fc56637',125.00,'2018-02-28 12:00:00-03','pix'),
    ('30f949fc-0b45-5c3f-a19d-a25468fa3cce','750d4af6-e4d1-57ad-990d-a26342099d9f','64b7c07d-440d-49da-ba08-40752fc56637',125.00,'2018-06-30 12:00:00-03','pix'),
    ('d02d6551-a4fc-5b58-87f6-4a58cb9be8ec','76536726-d347-5df2-b466-0646019512a8','64b7c07d-440d-49da-ba08-40752fc56637',125.00,'2018-11-30 12:00:00-03','pix'),
    ('1c8e273a-37e5-54d4-b429-737ff9cb9cd0','b3b6d9ae-dcab-537d-b8d2-a3d8b2c44c72','64b7c07d-440d-49da-ba08-40752fc56637',125.00,'2018-12-31 12:00:00-03','pix'),
    ('d735683e-c704-50fa-b319-95d8e10bb2f8','f70aacbd-22c4-51c0-a77f-2f96e8ac7f59','582217c1-836e-4828-a6f2-e2f2633ee060',125.00,'2018-02-28 12:00:00-03','pix'),
    ('40153cec-02e5-51d4-8947-4e21369a4fac','100c445f-6f79-5038-aa24-465f5b293e6a','582217c1-836e-4828-a6f2-e2f2633ee060',125.00,'2018-05-31 12:00:00-03','pix'),
    ('3e42a6fc-746c-5b4b-bad9-4307195aea82','012f4d38-2b65-5f2c-9ad8-9225ca0f0554','582217c1-836e-4828-a6f2-e2f2633ee060',125.00,'2018-08-31 12:00:00-03','pix'),
    ('7f8f7d12-86a1-5d92-abcf-4a406dfb615c','e4fc837c-adb4-5c3f-ba56-34aa2dd9eab2','582217c1-836e-4828-a6f2-e2f2633ee060',125.00,'2018-11-30 12:00:00-03','pix'),
    ('4a63139c-04ba-5cba-b64b-e913f8a48c7c','aef32420-f61e-5220-ba49-20d780f71cfb','9ef05b7f-dec6-40b7-a156-4da4e3467a94',130.46,'2018-02-28 12:00:00-03','pix'),
    ('a8e8fe04-dc5f-557c-b55c-0ade94f6633a','0321ee17-88ac-5f2a-afa4-f8fcac1d0958','9ef05b7f-dec6-40b7-a156-4da4e3467a94',125.00,'2018-05-31 12:00:00-03','pix'),
    ('0c0ea4e8-f9c6-5f03-ab10-a380372fb8ef','eabee85e-7613-507f-8647-26cd2561fb6f','9ef05b7f-dec6-40b7-a156-4da4e3467a94',147.26,'2018-08-31 12:00:00-03','pix'),
    ('b8859c6b-b14f-5e5b-b276-5914bc0d39a1','a6f3664b-87b6-56bf-b0af-337d866a3d0a','9ef05b7f-dec6-40b7-a156-4da4e3467a94',132.98,'2018-12-31 12:00:00-03','pix'),
    ('9c4e07c0-6a45-5c19-b75a-7620660e8c80','5bb5f19b-e362-5ae9-aa5e-63827e581415','66f767d4-ad54-49d9-9838-4dc83ea584e2',240.00,'2018-06-30 12:00:00-03','pix'),
    ('a9526f1b-f833-55f7-b151-cc20280c8cf8','2563a937-e008-5927-be24-206ff8e18f52','66f767d4-ad54-49d9-9838-4dc83ea584e2',125.00,'2018-10-31 12:00:00-03','dinheiro'),
    ('628deaa4-fbd7-58e2-a24f-6049a4a97d3d','0308aee6-9c83-5fd7-b432-55b0cd5dbe7f','66f767d4-ad54-49d9-9838-4dc83ea584e2',125.00,'2018-12-31 12:00:00-03','credito_cbkt'),
    ('3675065a-c4a1-50a2-8f42-3ef17fa89d14','ae80eba6-a13e-5d69-be17-b2d4537b96ab','794d63bf-ecd0-426e-9870-369cb2a8760a',125.00,'2018-02-28 12:00:00-03','pix'),
    ('c0bbb629-7adb-5c7c-8c05-860aa9645fc8','9a36a1de-d160-546c-8529-7c60f88a5801','794d63bf-ecd0-426e-9870-369cb2a8760a',125.00,'2018-05-31 12:00:00-03','pix'),
    ('6700154e-a9d6-50ce-8226-aca042a1baa2','d43bd865-8e26-591f-ae1c-e2fa4366bf58','794d63bf-ecd0-426e-9870-369cb2a8760a',125.00,'2018-08-31 12:00:00-03','pix'),
    ('51dfdc7e-13dc-5016-94b0-2d98e50b78c7','bb843caf-fb2e-5071-b6fc-31403b5cc12b','794d63bf-ecd0-426e-9870-369cb2a8760a',125.00,'2018-11-30 12:00:00-03','pix'),
    ('c96fd370-4c13-5882-9631-a90ea70c120e','dae35216-3821-5980-9412-adb995b67982','9d63c6ea-29e4-4217-b339-eecbd9bd743e',125.00,'2018-02-28 12:00:00-03','pix'),
    ('2d63acd0-cf4b-54d2-a20c-5b22ee37a282','c81217b9-bb45-520c-b804-b06ac12fd796','9d63c6ea-29e4-4217-b339-eecbd9bd743e',125.00,'2018-06-30 12:00:00-03','pix'),
    ('569a29bd-7cad-5b80-a324-80f89a5b2f56','64869bb9-2369-555f-8322-a643c72a5efd','9d63c6ea-29e4-4217-b339-eecbd9bd743e',125.00,'2018-09-30 12:00:00-03','pix'),
    ('03def188-e77d-5640-870b-73a30d6d3874','330d5ebb-2ef7-5c1b-8ad6-dc9e8e1f2bc0','9d63c6ea-29e4-4217-b339-eecbd9bd743e',125.00,'2018-11-30 12:00:00-03','pix'),
    ('5ee2439c-c8ff-5d1d-a92f-bbd20bb8db80','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',133.00,'2018-05-31 12:00:00-03','pix'),
    ('5085f24f-fdb8-51e8-8771-3da2b14ec6a2','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',132.00,'2018-06-30 12:00:00-03','pix'),
    ('3a8dff47-1f93-5432-a923-a14e0863e413','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',135.00,'2018-07-31 12:00:00-03','pix'),
    ('919c6004-ca53-5f44-9f73-f88254eeb236','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',133.00,'2018-08-31 12:00:00-03','pix'),
    ('8a33d758-3037-5b56-8c42-8db499f17707','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',136.00,'2018-09-30 12:00:00-03','pix'),
    ('a969d855-9850-54da-91fa-32d9bc956e96','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',125.00,'2018-10-31 12:00:00-03','pix'),
    ('96621118-81ac-5982-8838-78c65fa2167c','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',125.00,'2018-11-30 12:00:00-03','pix'),
    ('4c7fdb56-2972-5c3e-b119-b1cbba0b1253','7864cb77-6117-5d0d-bed1-76b4e744e70b','b7227a2f-5c25-403d-aaac-ace1f96143e7',125.00,'2018-12-31 12:00:00-03','pix'),
    ('4b397d3f-7810-5ca2-9469-1c61b6a69b0b','abfcf102-53d3-56b4-a354-2d896ffde2b3','a2dd5311-47d6-51d1-aa0d-6944e4a2a83b',430.00,'2018-06-30 12:00:00-03','pix'),
    ('af2bb7cc-48eb-5710-b5a4-6ea42e9e9fe9','a61a0d15-c6f6-5f5d-bb26-599f0803ba6f','33103410-96b7-4579-9a72-7c948ffdbcf5',125.00,'2018-11-30 12:00:00-03','pix'),
    ('aec64957-6525-5d7f-a8f1-480f3b0b8dca','5dc86306-bca9-5baa-b1da-22f2e50ba3b2','33103410-96b7-4579-9a72-7c948ffdbcf5',125.00,'2018-12-31 12:00:00-03','pix'),
    ('d6a2f047-216f-5251-95b1-68f09fbd57c6','849ea5a8-cb21-52fd-a1e1-007d570d282d','33103410-96b7-4579-9a72-7c948ffdbcf5',125.00,'2018-12-31 12:00:00-03','pix'),
    ('475cf607-febb-5dd9-8cd8-0f5e378e935c','aa96fc2f-0118-5a94-af69-2ca7c8da3e74','33103410-96b7-4579-9a72-7c948ffdbcf5',125.00,'2018-12-31 12:00:00-03','pix'),
    ('5215ec97-b46e-566d-81f3-bef3ec75005e','50023f64-ebcc-5f18-a7cf-b297c1a4936b','06a1a5cd-4a00-42ef-89db-42223ad59f50',240.00,'2018-05-31 12:00:00-03','pix'),
    ('e3e5ed7a-24eb-5e80-9183-ff53720f803b','0bfd7fbd-d4fc-541e-9683-be43f7d4b916','06a1a5cd-4a00-42ef-89db-42223ad59f50',240.00,'2018-11-30 12:00:00-03','pix'),
    ('96d75d7c-4b30-521c-b8f7-4c120a8205db','d0994c29-08f8-5ab7-a0a1-6a5756aa84e3','34399973-14e6-47ee-af96-31720975b3a0',430.00,'2018-06-30 12:00:00-03','credito_cbkt'),
    ('16fedd78-c101-5bb4-a465-376a12e9f39b','b495e757-9fb4-5d54-b729-b908e76b4689','1d9ceec1-6f5f-445a-aefa-5cbc53bf0d60',240.00,'2018-07-31 12:00:00-03','pix'),
    ('807ae24a-b88d-5ba8-81bc-e6b4e1478894','608af0d3-0b3d-51c6-b592-9688102fbaec','4b8afba1-b0c8-54e1-bcb7-54262e585acb',225.00,'2019-10-31 12:00:00-03',NULL),
    ('c6bd061a-df7c-5599-bd93-8927702c6048','39b01a61-6a57-5ae2-85e4-b25274db928b','00570113-cd26-43ba-808c-dff1c8d691b4',450.00,'2019-07-31 12:00:00-03','pix'),
    ('60ea784b-bf92-5e0e-94c3-9db3f2af1189','60cb9ef4-6131-59d2-a55f-485bfe471a75','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',125.00,'2019-04-30 12:00:00-03','pix'),
    ('ec9e03bc-83cf-51a2-a464-c18c6372b558','60cb9ef4-6131-59d2-a55f-485bfe471a75','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',5.00,'2019-05-31 12:00:00-03','pix'),
    ('1ef0055e-86af-553e-985b-ad41905dcd4c','754c83bf-cf96-5535-80f7-3ff4b3744528','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',130.00,'2019-05-31 12:00:00-03','pix'),
    ('0e1d777e-d3ba-5f40-8777-53c260cf9e43','5ee827c0-b807-5135-8d42-d89a9e9a5725','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',130.00,'2019-08-31 12:00:00-03','pix'),
    ('6821e2bc-32a1-5111-bd51-457e1aa1fa49','d5e7273b-6432-5d06-9ae5-8fa3aa51b7a3','15bf9b5c-bafa-4991-9ae8-e00bf0f4b049',130.00,'2019-12-31 12:00:00-03','dinheiro'),
    ('c5354914-7c91-5ff6-86db-d24ae63387b0','1926d6ef-8d57-55be-a180-d0bcfd66e07c','967e2297-3c06-432d-ab50-52a8386ce043',180.00,'2019-01-31 12:00:00-03','pix'),
    ('34f8938d-da67-5d8b-a224-785aaa8ae2de','576bdde5-143f-598a-ac92-85c4ccb627b9','967e2297-3c06-432d-ab50-52a8386ce043',450.00,'2019-01-31 12:00:00-03','pix'),
    ('ddbffe54-0b10-5b80-8b58-d142419b3ee7','fa605088-e01b-5278-9dbb-fc2735b2f41d','4b673e7d-e1af-4906-b459-43ff2fc82c76',150.00,'2019-05-31 12:00:00-03','pix'),
    ('661619ab-e1cb-5933-aff3-c74d394829f2','bf66ed2f-4a44-5018-981c-4168d280657e','4b673e7d-e1af-4906-b459-43ff2fc82c76',130.00,'2019-02-28 12:00:00-03','pix'),
    ('b3491679-bd5f-5b72-b836-ef6c0af878c3','346c7834-28c2-5855-b18e-eaacad0eab72','4b673e7d-e1af-4906-b459-43ff2fc82c76',130.00,'2019-05-31 12:00:00-03','pix'),
    ('c513631c-4269-5050-b169-36e169061bf1','d827b12e-734b-517d-bf30-04c10536516f','4b673e7d-e1af-4906-b459-43ff2fc82c76',130.00,'2019-09-30 12:00:00-03','pix'),
    ('dcde3092-08f2-5bd8-a65a-466a764533fb','345db690-b660-5c4c-8dd2-6ea9e109efcd','4b673e7d-e1af-4906-b459-43ff2fc82c76',130.00,'2019-11-30 12:00:00-03','pix'),
    ('23a8d63a-5e87-538a-90eb-d2425f3a3530','43083084-a0c5-550e-bae0-6a29ffe8d9b0','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',130.00,'2019-02-28 12:00:00-03','pix'),
    ('6f92e207-2035-5f01-9c78-b0131ec77b44','bf0554d9-f2a1-5a04-96e7-45af73d9732f','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',130.00,'2019-06-30 12:00:00-03','pix'),
    ('be35cd55-ea42-5789-9c15-ad92dbc7facb','e02167cb-2174-5396-9240-94eee5c9b258','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',130.00,'2019-06-30 12:00:00-03','pix'),
    ('ed0436d9-2f8a-5f30-a757-1f6f39bf435c','15a9d7b1-9826-5aa4-b777-92a929d97a68','a5fa0d56-0da6-4571-a296-6a7ddc2e6ae7',130.00,'2019-11-30 12:00:00-03','pix'),
    ('a380647f-e15f-588b-b4fe-0da7e1c3958c','b88ffa87-2e96-568f-afe5-be57e5b3991c','cf290543-3e2e-595c-a295-4425e95a1e79',130.00,'2019-01-31 12:00:00-03',NULL),
    ('35bd6e8c-c4f8-5a59-ad22-4123ff75e5e1','8e531154-19ad-5d33-9768-e8bf90edf510','cf290543-3e2e-595c-a295-4425e95a1e79',130.00,'2019-05-31 12:00:00-03',NULL),
    ('3cb2a3b0-0ce0-5a56-aac2-9e0b6ac42220','b934e49c-de02-5d1b-ab7e-6bcd6e4d52e3','cf290543-3e2e-595c-a295-4425e95a1e79',130.00,'2019-09-30 12:00:00-03','pix'),
    ('fb4fd2d5-f3f1-50d0-8268-45b99d1840ef','7c76c4ae-2c31-54f4-85d4-a21200b66461','cf290543-3e2e-595c-a295-4425e95a1e79',130.00,'2019-12-31 12:00:00-03','dinheiro'),
    ('4f8930fc-a972-5944-a9f4-7654034b128a','60d47994-4817-52c9-bc21-56f7774a49b1','dfe94ce2-0d18-466a-aadb-3c96172b73da',130.00,'2019-06-30 12:00:00-03','dinheiro'),
    ('cef20180-fc79-5687-88e5-18a19f294cde','2a9f5a04-469d-540b-b3b5-41d94e2ca6de','dfe94ce2-0d18-466a-aadb-3c96172b73da',130.00,'2019-06-30 12:00:00-03','dinheiro'),
    ('19daafaf-0418-5179-8e6c-3d19102e680a','eaafe694-d0c0-530d-ae28-da5b2a3716d1','dfe94ce2-0d18-466a-aadb-3c96172b73da',130.00,'2019-09-30 12:00:00-03','pix'),
    ('4fe746e8-79a3-5cea-ad59-31b31925c717','ce4c4cc5-3892-5196-a2c6-32b4fe050b58','dfe94ce2-0d18-466a-aadb-3c96172b73da',130.00,'2019-12-31 12:00:00-03','pix'),
    ('2a1c9934-b0e4-56ed-86f4-d26f7e6221ec','71eecc64-c9c2-5dee-904a-48520138c391','25828459-1dd5-4999-8d1f-e96bb7a34523',268.80,'2019-02-28 12:00:00-03','credito_cbkt'),
    ('744466de-8841-5189-bbe2-13d9fbad9cd8','71eecc64-c9c2-5dee-904a-48520138c391','25828459-1dd5-4999-8d1f-e96bb7a34523',182.00,'2019-04-30 12:00:00-03','pix'),
    ('0fdddc18-7d0d-5163-83e1-33dd8cf142d8','ff2b1f1e-5c44-5524-ae3d-7a7b8a3d3f6b','7aa59cbf-816f-463c-9dfb-010bf046938e',130.00,'2019-02-28 12:00:00-03','pix'),
    ('c3859c54-6f6f-56d0-b4de-6ee1413fe255','90ae468c-172e-5def-b60a-30c7c0e48445','7aa59cbf-816f-463c-9dfb-010bf046938e',130.00,'2019-05-31 12:00:00-03','pix'),
    ('f1e977fc-b59e-58d6-9458-2414bb63b098','79f8bff6-3fa5-5588-997a-e4a401bf0db0','7aa59cbf-816f-463c-9dfb-010bf046938e',130.00,'2019-12-31 12:00:00-03','pix'),
    ('f1632c6d-439b-507b-bd43-3d87ca89e2a6','347bbdcf-c03b-51b6-a2b5-1ad51a933086','7aa59cbf-816f-463c-9dfb-010bf046938e',130.00,'2019-12-31 12:00:00-03','pix'),
    ('003b9653-16a2-586a-97d4-ef3ee7635f7b','44df89d5-9a06-5f2f-a249-6ce78f71996a','b6d664f5-6811-4538-92d4-de7213a87cb3',130.00,'2019-02-28 12:00:00-03','pix'),
    ('0bcd09dc-c8e4-5f28-9141-56235ebc9203','776334fa-df8f-5939-95a8-4b0deee78a61','b6d664f5-6811-4538-92d4-de7213a87cb3',130.00,'2019-05-31 12:00:00-03','pix'),
    ('bf5f567f-2868-5e33-bcb0-1cc23aaab13c','064e48d2-f66f-5563-b46e-7811d482a695','b6d664f5-6811-4538-92d4-de7213a87cb3',130.00,'2019-08-31 12:00:00-03','pix'),
    ('624ac069-7422-5dc8-95e2-d7f37ae5eed3','38514225-864a-5923-a708-7cb6d40eea53','b6d664f5-6811-4538-92d4-de7213a87cb3',130.00,'2019-11-30 12:00:00-03','pix'),
    ('6c054dd8-d013-5ace-bd87-c8e1f992366c','dadc4a72-fd55-56ed-9eb1-0fe43e92b16f','442fdcbb-3a0f-474e-8715-6668487d2a83',130.00,'2020-02-28 12:00:00-03','pix'),
    ('fc107438-bf2b-5488-81d4-557fdcb28c50','dadc4a72-fd55-56ed-9eb1-0fe43e92b16f','442fdcbb-3a0f-474e-8715-6668487d2a83',130.00,'2020-07-30 12:00:00-03','dinheiro'),
    ('19659acd-2ea8-5dfe-a9ce-622d752faa7f','dadc4a72-fd55-56ed-9eb1-0fe43e92b16f','442fdcbb-3a0f-474e-8715-6668487d2a83',190.00,'2020-09-30 12:00:00-03','dinheiro'),
    ('068f32f8-0358-5b3e-ab7c-605b1acb31ab','89102422-af1c-5ba8-957b-7817074f1508','5023e599-7591-46be-a274-7b8d8faf9e2c',450.00,'2021-02-28 12:00:00-03','outro'),
    ('632be9b7-c5f5-5988-8d8e-911a022f0cba','5c9f1bff-f8ac-51a8-8f0c-93aa9f1fe734','97d06e18-6b27-41ef-90dd-97fc3532c39c',130.00,'2020-02-28 12:00:00-03','credito_cbkt'),
    ('7d9f1790-cfd6-52d7-8bd5-4761c972ddc2','bc6a4793-83e1-53f7-91dc-89025c52d43f','97d06e18-6b27-41ef-90dd-97fc3532c39c',130.00,'2020-09-30 12:00:00-03','pix'),
    ('01d7282c-db7e-5b9a-bbf7-5aae699d89a2','71faeda3-0f16-54f4-9a63-184de77b4bee','97d06e18-6b27-41ef-90dd-97fc3532c39c',130.00,'2020-09-30 12:00:00-03','pix'),
    ('078a6447-fdda-5dd0-98e5-d23209167c3d','b1c0f6c2-88d3-56cc-a1a5-52db7a98c26d','fd9305a6-3844-4887-985f-bfc22d06e712',130.00,'2020-02-29 12:00:00-03','pix'),
    ('9d40a81f-dfc6-5f4d-bd5d-28a4416b6515','9250a48f-b116-5842-b584-ee66ef1062d5','fd9305a6-3844-4887-985f-bfc22d06e712',130.00,'2020-05-31 12:00:00-03','pix'),
    ('919d8abb-2cdd-5d9b-8615-9e09f9eb5bf8','8cb767c8-1352-5656-ab46-3ba417921f16','18407eb5-3a56-428e-a847-4f2eed2d01bb',130.00,'2020-03-30 12:00:00-03','boleto'),
    ('5743bd6d-ecef-571b-9593-1eed0da27f05','89b2bd25-f471-52ef-bc44-7d34172f7dfe','18407eb5-3a56-428e-a847-4f2eed2d01bb',130.00,'2020-06-30 12:00:00-03','pix'),
    ('0939bafd-4f2d-509f-a80e-baea83a47872','347516e1-dcf2-56df-b53e-fca95e193125','18407eb5-3a56-428e-a847-4f2eed2d01bb',130.00,'2020-08-31 12:00:00-03','pix'),
    ('ec0706ab-4eb4-5c4d-b7e3-604e456c49ba','3013ba93-3127-509d-8ce8-a36f59889b34','18407eb5-3a56-428e-a847-4f2eed2d01bb',130.00,'2020-11-30 12:00:00-03','pix'),
    ('8728674a-b3cf-5c3e-b93e-add2b45b3928','86b53e26-04ef-57ad-b647-7d7f5d2ef1ee','b4f1cea2-dac4-4802-a211-f1b4da3123f4',130.00,'2020-02-28 12:00:00-03','credito_exame'),
    ('59821b50-176c-584d-921e-def84305ee6a','017caa1f-35d3-56e6-b55d-a254df98d8f6','b4f1cea2-dac4-4802-a211-f1b4da3123f4',280.00,'2020-11-30 12:00:00-03','pix'),
    ('7537708d-dcc0-512d-a74b-0dbee29a79d8','e2c2d24d-ac73-5015-bd33-4c41b783e3a6','39cfeb23-3b86-4e2c-9ca5-5822c83e66f4',130.00,'2020-02-28 12:00:00-03','pix'),
    ('61b24d6f-89af-511c-b222-87f3304a53e7','f6f154c9-39c8-5334-92a8-bac1201e5bae','39cfeb23-3b86-4e2c-9ca5-5822c83e66f4',130.00,'2020-05-31 12:00:00-03','pix'),
    ('1050effc-6e50-56ee-8d5d-e9070db98663','3f77f356-a0ae-5d10-9087-65bbe05903ae','39cfeb23-3b86-4e2c-9ca5-5822c83e66f4',130.00,'2020-08-31 12:00:00-03','pix'),
    ('7473fa14-48eb-51cb-bc4a-a80e40c9cf9e','f14d63de-3933-5b58-895c-b0379e99300d','e67f1599-04fd-4f1d-abfe-524982de0da6',182.00,'2020-08-31 12:00:00-03','credito_exame'),
    ('4b04048b-8423-5f89-9509-b74c59687950','f14d63de-3933-5b58-895c-b0379e99300d','e67f1599-04fd-4f1d-abfe-524982de0da6',218.00,'2020-09-30 12:00:00-03','pix'),
    ('a15ab96d-f697-52aa-8965-53a161005896','f2da236c-86ad-591f-835c-ae102501c959','af429fe5-28ae-47dc-a311-855b334ea844',130.00,'2020-02-28 12:00:00-03','pix'),
    ('855bd2fd-03f8-5c9e-a635-f5d7300726c4','8925a3e3-00ee-58a5-b8f9-7d1f8fdbc56a','af429fe5-28ae-47dc-a311-855b334ea844',130.00,'2020-12-31 12:00:00-03','pix'),
    ('97db58f1-a157-5a0f-b1f9-58f972985496','3f5113cd-ba70-58d0-a7f7-2b1b669ea576','af429fe5-28ae-47dc-a311-855b334ea844',130.00,'2020-12-31 12:00:00-03','pix'),
    ('4af82c48-aebb-54e1-9ce9-8fb112824674','fc2aed18-ab12-5dfe-b5c6-4e43edec8f0c','b3380551-3a25-4c19-90dd-d8bac9805d9f',210.00,'2021-06-30 12:00:00-03','credito_exame'),
    ('3fda580a-eb3e-5190-bfbd-ff67e358c51c','fc2aed18-ab12-5dfe-b5c6-4e43edec8f0c','b3380551-3a25-4c19-90dd-d8bac9805d9f',40.00,'2021-07-31 12:00:00-03','pix'),
    ('c1459d2a-bb85-52e5-be18-c9b1a0dffaaf','ec04999c-751b-56ed-ac01-7ab6ec532933','b3380551-3a25-4c19-90dd-d8bac9805d9f',250.00,'2021-12-31 12:00:00-03','dinheiro'),
    ('06ed83e9-c121-5cf4-86e5-a9e6007ff04c','8ab66178-ff01-5b40-9227-77ad392f18ff','9637f251-e900-420d-8e85-b28467810d52',250.00,'2021-07-31 12:00:00-03','credito_exame'),
    ('e8e9b1c4-d117-560d-995d-32b269f9be91','3aa2764c-a951-59d7-b4c0-3549b4e84574','9637f251-e900-420d-8e85-b28467810d52',150.00,'2021-07-31 12:00:00-03','credito_exame'),
    ('fe4260e7-6c05-519b-9153-91e4f784ee2b','3aa2764c-a951-59d7-b4c0-3549b4e84574','9637f251-e900-420d-8e85-b28467810d52',100.00,'2021-11-30 12:00:00-03','pix'),
    ('cecf3a21-e05b-5513-9efa-b3b7ea587caa','de4e33e0-7fef-5e6e-9510-3ffa4fec2428','6039b798-90ee-447d-97a4-b6fe0e131f8d',150.00,'2022-02-28 12:00:00-03','pix'),
    ('558847ca-5fac-56b5-a544-fac33c3884a5','cffae493-6c26-5ce8-b09a-32ca4dd30767','6039b798-90ee-447d-97a4-b6fe0e131f8d',188.00,'2022-03-30 12:00:00-03','pix'),
    ('a42c5f37-1358-526b-b04f-f2caf2a97be6','7d3e6139-a67b-5341-9709-6cb97d63546a','6039b798-90ee-447d-97a4-b6fe0e131f8d',188.00,'2022-11-30 12:00:00-03','pix'),
    ('f2d6a293-a2ab-5787-a8a1-7f8ba395b07d','f17e1a46-eb30-5f96-8105-3042b80bc934','922fd55a-ce92-4895-882c-20c4c76c9fbf',308.00,'2022-04-30 12:00:00-03','credito_exame'),
    ('5c6dcb9a-918a-5d35-a976-cd2339c4a2f1','f17e1a46-eb30-5f96-8105-3042b80bc934','922fd55a-ce92-4895-882c-20c4c76c9fbf',142.00,'2022-05-31 12:00:00-03','pix'),
    ('fb22089f-dd3a-53d2-95fb-2b3bfd15a903','9997b247-6667-519f-bc00-28095da091ee','1eeebba1-9489-4b6c-ba77-c27f89f80793',130.00,'2022-11-30 12:00:00-03','pix'),
    ('5f6405a5-b725-5a89-8ed0-53ab5fa5b127','160d026c-aed0-50d2-874d-7bf82d33fb13','1eeebba1-9489-4b6c-ba77-c27f89f80793',130.00,'2022-11-30 12:00:00-03','pix'),
    ('f572f105-bddd-5a0b-805b-9d4dbb87c7b2','d79cce7c-f0b6-5ae4-bcab-c6ab01e5b2a7','1eeebba1-9489-4b6c-ba77-c27f89f80793',130.00,'2022-11-30 12:00:00-03','pix'),
    ('4d9e67ce-1050-5be0-b3a6-ac55479028cd','b73d6cc7-c9cf-591a-b2ab-e9b2c596c51d','1eeebba1-9489-4b6c-ba77-c27f89f80793',130.00,'2022-11-30 12:00:00-03','pix'),
    ('fc1750dc-adbb-5223-9497-09d60873fd7c','915043e0-8821-5c84-a110-cafea859e314','5fb79045-1a15-4b6d-a1cd-57b1f9a3784c',450.00,'2022-07-31 12:00:00-03','pix'),
    ('a031e2d3-7fa2-5e31-af61-03018404b0aa','2deec74c-3c9b-5b39-a9e0-4f325a34f90f','4116f847-0278-450f-9f42-1ec949b1fec4',130.00,'2022-02-28 12:00:00-03','pix'),
    ('b7529705-afe0-5b81-9673-a7e8c16b91a5','1b66ca03-7d84-5a90-a608-8a12b5a80dac','4116f847-0278-450f-9f42-1ec949b1fec4',130.00,'2022-06-30 12:00:00-03','pix'),
    ('f95959d3-42a8-563e-a337-e19cee9befef','37c4ed6c-951c-540e-963e-f946269c90b6','4116f847-0278-450f-9f42-1ec949b1fec4',130.00,'2022-09-30 12:00:00-03','pix'),
    ('6ba9c7ff-e844-580d-af5e-dc0cee5768db','62387a46-b646-5171-aaa5-b107896cd09f','4116f847-0278-450f-9f42-1ec949b1fec4',130.00,'2022-12-31 12:00:00-03','pix'),
    ('8b84036f-9b07-5b8a-a7a9-f194dfe330bc','c26229f4-a793-52fe-8a04-700b10a1a474','41884f9a-cee1-4e4d-a44d-e30e9afc0e8c',480.00,'2023-02-28 12:00:00-03','credito_exame'),
    ('7b8beca8-7aa5-5ac3-8843-2cacedb4f97f','0abe66a4-9024-5b62-8110-53c10218f859','e9691e6c-c007-48c8-892f-02d56e35d856',74.00,'2023-02-28 12:00:00-03','credito_exame'),
    ('d7879f64-4e10-58ae-8d6c-31fbebe47e2b','0abe66a4-9024-5b62-8110-53c10218f859','e9691e6c-c007-48c8-892f-02d56e35d856',406.00,'2023-05-31 12:00:00-03','boleto'),
    ('81815a13-7aaa-5da7-bd5d-2247a84dee9d','5c57f829-b094-5a66-ab87-4f0ddf0e7994','d1a2d469-5cd7-4aae-a960-cfade2207f40',280.00,'2023-03-31 12:00:00-03','pix'),
    ('a2cff993-a43a-5723-849b-43eca88422e9','8670f5ea-7106-5a6f-9340-6a0867c24a4a','d1a2d469-5cd7-4aae-a960-cfade2207f40',39.45,'2023-05-31 12:00:00-03','dinheiro'),
    ('1f46f889-b936-5e50-8c33-deffb722245b','440eeca9-32a8-52cd-8fd6-ae638eb61d58','d1a2d469-5cd7-4aae-a960-cfade2207f40',280.01,'2023-08-31 12:00:00-03','pix'),
    ('7daefdae-f64c-5e01-8330-942b0773d48a','10ec882f-e2e8-5737-a840-b2bc9a86adfc','969156ac-f108-4a74-a5de-ed11d6437c21',173.00,'2023-02-28 12:00:00-03','credito_exame'),
    ('c62ee8ab-3beb-5571-8e71-eafdda69a4c2','10ec882f-e2e8-5737-a840-b2bc9a86adfc','969156ac-f108-4a74-a5de-ed11d6437c21',92.00,'2023-09-30 12:00:00-03','credito_cbkt'),
    ('bba20179-b514-592f-b2ba-b5214ba76d93','60d23c73-01aa-5b6e-b84b-03aed4803d6d','969156ac-f108-4a74-a5de-ed11d6437c21',265.00,'2023-09-30 12:00:00-03','credito_cbkt'),
    ('c63abeaa-7a93-502d-b55e-6282b468f3dc','e36809da-bd8e-524b-aa0a-9f484c75cb24','c062a4ee-aa9a-47fe-afce-cde499581bf6',226.00,'2023-02-28 12:00:00-03','credito_exame'),
    ('ee36eb91-ac6c-5c7b-b35a-a06e241cab7b','e36809da-bd8e-524b-aa0a-9f484c75cb24','c062a4ee-aa9a-47fe-afce-cde499581bf6',70.00,'2023-04-30 12:00:00-03','pix'),
    ('97f57a4f-41da-5032-88f1-ca880b34c4e2','e36809da-bd8e-524b-aa0a-9f484c75cb24','c062a4ee-aa9a-47fe-afce-cde499581bf6',184.00,'2023-08-31 12:00:00-03','pix'),
    ('bd9652c8-7880-5d18-8417-3c9413cb13b6','b1e79ed5-3e42-5f42-8a2a-ac80bcd0ffcb','f763c512-d1eb-43f9-a9c4-001f100e2b44',194.00,'2023-02-28 12:00:00-03','credito_exame'),
    ('c801e005-0506-588c-bc9d-afee36c4a11c','b1e79ed5-3e42-5f42-8a2a-ac80bcd0ffcb','f763c512-d1eb-43f9-a9c4-001f100e2b44',286.00,'2023-09-30 12:00:00-03','dinheiro'),
    ('ea394b93-422d-59f2-a7e4-9c78c0b9b37f','f76b3919-f10e-5655-8e51-b1755d73a772','5ef42424-ae75-475f-9a06-056ff57aeb2e',140.00,'2023-02-28 12:00:00-03','pix'),
    ('9f4dd9ce-654d-5c8b-a8f4-9cf05620348c','e328652e-b2a3-5756-8414-eb4be401f249','5ef42424-ae75-475f-9a06-056ff57aeb2e',140.00,'2023-03-30 12:00:00-03','pix'),
    ('7df8e502-5abe-5613-980c-a696f926a8b2','a60b5950-4690-52ba-a2d9-bd71477a18d1','5ef42424-ae75-475f-9a06-056ff57aeb2e',140.00,'2023-09-30 12:00:00-03','dinheiro'),
    ('026407a0-5abc-54b5-880b-72a42c7454b7','3fd085c9-3ecc-509d-bd23-0cf08ae265e0','5ef42424-ae75-475f-9a06-056ff57aeb2e',140.00,'2023-09-30 12:00:00-03','dinheiro'),
    ('822d3b53-aa46-593a-9b88-4f121f84f250','7676c2aa-ce44-5a96-a621-66cc6dbc6b5a','83d56c0e-72ca-4124-a1d0-6392fd077b2d',140.00,'2023-03-30 12:00:00-03','pix'),
    ('63b9565b-ef85-507c-8b76-1d191ad12d54','8f865b74-537e-54d5-a097-ec2b903a03f5','83d56c0e-72ca-4124-a1d0-6392fd077b2d',140.00,'2023-05-31 12:00:00-03','pix'),
    ('015ab479-5689-522e-8b07-edd3388f76e6','5eda0d06-d19d-5780-bd75-70617150f1eb','83d56c0e-72ca-4124-a1d0-6392fd077b2d',140.00,'2023-09-30 12:00:00-03','pix'),
    ('683269c6-7cf9-532a-bb73-7e6a92bd448a','891f3984-c356-58ef-b01c-1775e64a20a4','83d56c0e-72ca-4124-a1d0-6392fd077b2d',140.00,'2023-12-30 12:00:00-03','pix'),
    ('696fb512-9244-50a7-8ae8-907603ee5943','e686f18d-f169-5ff4-b65a-a571136d43ca','77a5695c-215a-49e3-986d-51aa18dd4778',500.00,'2024-02-28 12:00:00-03','credito_exame'),
    ('cbe9764b-4a82-5fcc-99c5-1a013dc9f5a9','a0a92fdd-cb69-598b-baef-b0bb3c443f2e','e2b758c8-9d25-458f-bb93-39ef02500100',150.00,'2024-04-30 12:00:00-03','pix'),
    ('a1a46017-ef7e-54eb-a7d3-fa92e9655625','5069d6b3-a6a1-5342-bddf-a50515c09c53','e2b758c8-9d25-458f-bb93-39ef02500100',150.00,'2024-05-31 12:00:00-03','pix'),
    ('0fdc185d-5be5-59c6-a583-2d33f2e503b5','ee5d8def-bf72-5acc-a505-d9d31e139f76','e2b758c8-9d25-458f-bb93-39ef02500100',150.00,'2024-10-31 12:00:00-03','pix'),
    ('9e0a16db-9cb2-5001-abab-eaf5de7c2c55','591718c1-ec20-5780-ba48-058e1bd4ace6','e2b758c8-9d25-458f-bb93-39ef02500100',150.00,'2024-10-31 12:00:00-03','pix'),
    ('b6a0a4bc-c209-52f8-9b16-29063607c389','35e7d56b-645b-5e83-aa54-511d2239caf6','9340f9f8-7c7a-4ed2-a37d-9d14ba85269d',140.00,'2024-02-28 12:00:00-03','credito_exame'),
    ('3be24536-b3f3-587e-9ab2-99f6154bd6c7','35e7d56b-645b-5e83-aa54-511d2239caf6','9340f9f8-7c7a-4ed2-a37d-9d14ba85269d',140.00,'2024-06-30 12:00:00-03','pix'),
    ('cb801b73-52b5-5bf1-850d-1453941ffac9','85c237cd-bfa8-5b42-935b-37e466ccd4a2','9340f9f8-7c7a-4ed2-a37d-9d14ba85269d',80.00,'2024-11-30 12:00:00-03','pix'),
    ('6ce70904-920f-5180-b2d8-b9f7cdab55e9','85c237cd-bfa8-5b42-935b-37e466ccd4a2','9340f9f8-7c7a-4ed2-a37d-9d14ba85269d',200.00,'2024-12-30 12:00:00-03','pix'),
    ('20dc8482-ce96-5def-9e5b-a76c6d168a41','3caa65a3-6d4c-5d2d-bc3c-d748a0bd2195','3abc01c3-3f3b-4d4b-8d60-2102300118d1',500.00,'2024-05-31 12:00:00-03','boleto'),
    ('20709f07-6c2e-561a-a051-438d9e798580','7628d622-577c-58e9-9287-108c16e0ebab','958d5489-ce57-4805-ac99-175f87f691c0',70.00,'2024-02-28 12:00:00-03','credito_exame'),
    ('bd11872e-b453-5f80-8155-44010ccd7d71','7628d622-577c-58e9-9287-108c16e0ebab','958d5489-ce57-4805-ac99-175f87f691c0',210.00,'2024-06-30 12:00:00-03','pix'),
    ('982e8974-479f-550b-ab2e-6f111934ddcc','2e3c8a44-8dd7-54fc-a33b-8de95a59c6d9','958d5489-ce57-4805-ac99-175f87f691c0',280.00,'2024-11-30 12:00:00-03','pix'),
    ('2b14b1ae-a3f8-5858-9f02-f07ce15932d9','919e041f-9c39-547e-8387-9a282356d6aa','a5c56f0c-9c19-49de-880e-db70b7c283c1',288.00,'2024-02-28 12:00:00-03','credito_exame'),
    ('493c3310-369f-5908-9d84-394b5e177bd5','919e041f-9c39-547e-8387-9a282356d6aa','a5c56f0c-9c19-49de-880e-db70b7c283c1',212.00,'2024-05-31 12:00:00-03','pix'),
    ('cd86e5f7-710c-50ff-a6b6-1043ff749d27','eb551a3a-d0b4-5e90-9704-0bae7f6f94f1','a5288db5-c2c4-4657-817e-925ecb2d6135',195.00,'2024-09-30 12:00:00-03','pix'),
    ('1643bffe-4b0b-5357-9295-a98f6ea18aa4','11933861-cc07-582c-b6d8-14f55efaf794','a5288db5-c2c4-4657-817e-925ecb2d6135',125.00,'2024-10-31 12:00:00-03','pix'),
    ('4155ee50-4752-51dd-87b6-fe4a84b57d78','072ab9e0-7288-586c-a166-7a408d8f0da1','9ae079b7-2af2-4745-968f-6348bd4ed68e',500.00,'2024-07-30 12:00:00-03','pix'),
    ('20fe3111-a037-5599-8f39-9bdbcb74b7e1','64f89767-a450-5233-b7e4-046e72a71d30','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',150.00,'2024-02-28 12:00:00-03','pix'),
    ('243e0937-68e6-5b97-b483-bd376de48d05','fa6306e6-e2bc-5896-8542-29ad7f1fab3b','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',150.00,'2024-06-30 12:00:00-03','pix'),
    ('8c489077-5abf-5f5b-b716-6a3919c58c8d','92ffe4a7-7c3a-5290-b70b-f1b9de176e1b','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',150.00,'2024-09-30 12:00:00-03','pix'),
    ('3a46139a-b90f-5250-8d6e-53cbdafa4b87','59835dbc-956e-5c72-9d8d-c52576afac76','a136cfd4-6a7c-45b2-93f7-0ece44b7217c',150.00,'2024-11-30 12:00:00-03','pix'),
    ('ba082420-3283-5743-a37c-3c988bb02c3a','ec592b8e-8d76-5338-9c3d-8440244f6289','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',150.00,'2024-02-28 12:00:00-03','pix'),
    ('69d55259-0f7c-5dc9-9f1c-f8cbcb0db120','57781756-0fe9-5c93-8197-6f8ccdc4f684','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',150.00,'2024-06-30 12:00:00-03','pix'),
    ('9ee54b84-9686-551e-baff-5a2455e9451f','167f0e66-4e33-5eb2-b589-3f8987c45642','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',140.00,'2024-10-31 12:00:00-03','pix'),
    ('a7bcc952-ba09-5489-84ed-b0465abae21b','167f0e66-4e33-5eb2-b589-3f8987c45642','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',10.00,'2024-12-30 12:00:00-03','pix'),
    ('c7b1b9c7-3460-598a-b76e-737f6c7b3e60','4c5a706f-f0db-5d4f-bc7a-e6f6984c9825','b0e863ea-dac2-45a9-804c-0ed7bdf8266e',150.00,'2024-12-30 12:00:00-03','pix'),
    ('25d8ce29-ec31-5e33-af9b-8e3bfa799982','cc963a35-93e0-5332-bf89-2ff33fb6bc81','05f8c3b1-05c2-4fdd-8569-3ca891c72775',100.00,'2025-02-28 12:00:00-03','credito_exame'),
    ('3cb07ef3-9096-55be-966c-d33dfecf9211','cc963a35-93e0-5332-bf89-2ff33fb6bc81','05f8c3b1-05c2-4fdd-8569-3ca891c72775',180.00,'2025-06-30 12:00:00-03','pix'),
    ('919edb80-e0e4-5e63-b238-b8382e267d72','97e1c009-9610-5ae2-b902-f0867f03471b','05f8c3b1-05c2-4fdd-8569-3ca891c72775',280.00,'2025-12-30 12:00:00-03','pix'),
    ('cf38b015-a804-5021-8db6-0805b830e1c1','9592bea2-1334-57ba-9482-f96ce90a5b83','e9f6bd2c-a3d9-44d4-8c32-9690b5fbe7bc',140.00,'2025-02-28 12:00:00-03','credito_exame'),
    ('c9b2be9e-e7d9-5ecb-92b9-6b82eed13aee','9592bea2-1334-57ba-9482-f96ce90a5b83','e9f6bd2c-a3d9-44d4-8c32-9690b5fbe7bc',500.00,'2025-07-30 12:00:00-03','pix'),
    ('f83116fc-3d24-51f3-85fb-0b4af0514d63','af4baeb8-f328-5e1d-afc9-9f7c1250069a','1d77b8f5-49e3-4208-b112-51f580a13425',310.00,'2025-02-28 12:00:00-03','credito_exame'),
    ('a30543dd-9cf7-59ff-b54b-b630cb96d55e','9e7973dd-3f85-545b-9ce5-39c13a0afa9f','1d77b8f5-49e3-4208-b112-51f580a13425',200.00,'2025-03-30 12:00:00-03','pix'),
    ('70cb169e-1be8-54d4-b379-395dfcc2b095','4c7dc4f7-4268-5e47-bd9f-58c343536e85','3516edcd-41a5-4ea7-bd14-e7a48360a2fd',500.00,'2025-05-31 12:00:00-03','boleto'),
    ('83f6b801-9b83-5ab2-83bb-56303ba23bda','2f9e8e03-2419-5076-82e5-427d24acc683','66d25ed8-c18d-44e3-a4e6-8f1e4b0f3c54',255.00,'2025-02-28 12:00:00-03','pix'),
    ('c2ee2919-ee21-5336-a70c-01d52f2445fb','2f9e8e03-2419-5076-82e5-427d24acc683','66d25ed8-c18d-44e3-a4e6-8f1e4b0f3c54',240.00,'2025-03-30 12:00:00-03','credito_exame'),
    ('046875cd-df41-57ed-9f74-69314bcd2d14','9e330e0c-ec86-5d3d-b971-0d3176efbf97','831fe3c4-0e6a-4360-beb9-f1537e09aecc',255.00,'2025-02-28 12:00:00-03','pix'),
    ('75d5638f-3da0-55b9-b706-76f0abdda98d','ef313ba0-e373-51b1-80f8-0f3a6ec099c7','831fe3c4-0e6a-4360-beb9-f1537e09aecc',245.00,'2025-09-30 12:00:00-03','pix'),
    ('2dd1ee65-d2a9-5ab0-80e7-33beebac3217','0405114d-d8f0-56b2-bc73-25f118bd6050','12f7c790-9b58-4350-8683-7a5533a73384',500.00,'2025-06-30 12:00:00-03','pix'),
    ('6022b523-0cf9-547b-b78b-a0375d84f40f','31e5a56e-37c7-5a1a-ae33-642d0244a313','6ac6d03a-4b96-4e38-828d-001de6990860',500.00,'2025-06-30 12:00:00-03','boleto'),
    ('7305bac8-448f-54a0-a741-966c6447775b','8917af59-3f94-5aeb-ba44-255426d608fa','94dbd8ac-27e8-4805-ace6-2c7aef1bbc8d',140.00,'2025-02-28 12:00:00-03','credito_exame'),
    ('d0f6fb36-4509-5e74-b68d-e0336e813966','8917af59-3f94-5aeb-ba44-255426d608fa','94dbd8ac-27e8-4805-ace6-2c7aef1bbc8d',140.00,'2025-07-30 12:00:00-03','pix'),
    ('6156d87a-ef16-54d4-83dc-bd310e719af5','e57edd29-7613-592a-bf1a-4057ee9ef447','94dbd8ac-27e8-4805-ace6-2c7aef1bbc8d',280.00,'2025-07-30 12:00:00-03','pix'),
    ('7f2e4b2d-df0d-52da-8029-d0e525e32ddf','5f00ff87-30fe-50a6-9d6f-0596890ae8f2','7971ae36-8788-4813-9949-a1041cd3fff0',150.00,'2025-02-28 12:00:00-03','pix'),
    ('34eb5c20-d863-5681-a655-d78bed7a9931','bccf2de3-cd5a-50b5-88bd-5009a70e0c84','7971ae36-8788-4813-9949-a1041cd3fff0',150.00,'2025-06-30 12:00:00-03','pix'),
    ('54bda6b8-c108-5df8-b45b-efd1eb0f542e','65d80428-abc5-529f-9623-d0e8e0e0f033','7971ae36-8788-4813-9949-a1041cd3fff0',150.00,'2025-09-30 12:00:00-03','pix'),
    ('7a1bf569-4e68-5191-826a-16226b226dd0','ed8920cf-a64e-5e64-b833-30ae3001de63','7971ae36-8788-4813-9949-a1041cd3fff0',150.00,'2025-12-30 12:00:00-03','pix');

DO $$
DECLARE
  v_fed      constant uuid := '274994b3-6324-4e7b-942e-e6dd19666149';
  v_bad      text;
  v_upd      integer;
  v_new      integer;
  v_inst     integer;
  v_led      integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = v_fed) THEN
    RAISE NOTICE '344: FPKT ausente neste banco - nada a fazer';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM karate_dojo_annuity_history WHERE id = '943707e4-dbe3-5ceb-89aa-519f693a2b8e') THEN
    RAISE NOTICE '344: ja aplicada - nada a fazer';
    RETURN;
  END IF;

  -- anuidade alterada pelo app depois da carga da 282: nao sobrescreve
  SELECT string_agg(h.id::text || ' ' || h.reference_period, ', ') INTO v_bad
    FROM _m344_hdr t JOIN karate_dojo_annuity_history h ON h.id = t.id
   WHERE NOT t.is_new
     AND (h.federation_id <> v_fed
          OR h.dojo_id <> t.dojo_id
          OR h.updated_at > '2026-08-14 02:00:00+00'
          OR h.transaction_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM karate_annuity_installments i
                      WHERE i.annuity_id = h.id
                        AND (i.transaction_id IS NOT NULL OR i.updated_at > '2026-08-14 02:00:00+00'))
          OR EXISTS (SELECT 1 FROM karate_annuity_payments p WHERE p.annuity_id = h.id));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '344: anuidades mudaram depois da carga da 282, revisar antes: %', v_bad;
  END IF;
  IF (SELECT count(*) FROM _m344_hdr t JOIN karate_dojo_annuity_history h ON h.id = t.id WHERE NOT t.is_new) <> 76 THEN
    RAISE EXCEPTION '344: anuidades a corrigir nao encontradas (esperado 76)';
  END IF;
  -- periodo novo nao pode colidir com outra anuidade do mesmo dojo
  SELECT string_agg(t.dojo_id::text || ' ' || t.reference_period, ', ') INTO v_bad
    FROM _m344_hdr t JOIN karate_dojo_annuity_history h
      ON h.dojo_id = t.dojo_id AND h.reference_period = t.reference_period AND h.id <> t.id;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '344: periodo ja ocupado: %', v_bad;
  END IF;

  UPDATE karate_dojo_annuity_history h
     SET reference_period = t.reference_period,
         plan = t.plan,
         amount = t.amount,
         status = t.status,
         paid_at = t.paid_at,
         payment_method = t.payment_method,
         due_date = t.due_date
    FROM _m344_hdr t
   WHERE h.id = t.id AND NOT t.is_new;
  GET DIAGNOSTICS v_upd = ROW_COUNT;

  DELETE FROM karate_annuity_installments i
   USING _m344_hdr t
   WHERE i.annuity_id = t.id AND NOT t.is_new;

  INSERT INTO karate_dojo_annuity_history
    (id, dojo_id, federation_id, reference_period, amount, paid_at, status, due_date, payment_method, plan)
  SELECT t.id, t.dojo_id, v_fed, t.reference_period, t.amount, t.paid_at, t.status, t.due_date, t.payment_method, t.plan
    FROM _m344_hdr t
    JOIN companies c ON c.id = t.dojo_id
   WHERE t.is_new;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  IF v_new <> 5 THEN
    RAISE EXCEPTION '344: esperado 5 anuidades novas, inseridas %', v_new;
  END IF;

  INSERT INTO karate_annuity_installments
    (id, annuity_id, federation_id, seq, kind, amount, amount_paid, due_date, paid_at, payment_method, status)
  SELECT id, annuity_id, v_fed, seq, kind, amount, amount_paid, due_date, paid_at, payment_method, status
    FROM _m344_inst;
  GET DIAGNOSTICS v_inst = ROW_COUNT;

  INSERT INTO karate_annuity_payments
    (id, federation_id, installment_id, annuity_id, amount, paid_at, payment_method)
  SELECT id, v_fed, installment_id, annuity_id, amount, paid_at, payment_method
    FROM _m344_led;
  GET DIAGNOSTICS v_led = ROW_COUNT;

  -- conferencia: cabecalho = soma das parcelas = soma dos recebimentos
  SELECT string_agg(t.id::text, ', ') INTO v_bad
    FROM _m344_hdr t
   WHERE t.amount <> (SELECT sum(amount) FROM karate_annuity_installments WHERE annuity_id = t.id)
      OR (SELECT sum(amount_paid) FROM karate_annuity_installments WHERE annuity_id = t.id)
         <> (SELECT sum(amount) FROM karate_annuity_payments WHERE annuity_id = t.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '344: totais nao fecham: %', v_bad;
  END IF;

  RAISE NOTICE '344: % anuidades corrigidas, % novas, % parcelas, % recebimentos', v_upd, v_new, v_inst, v_led;
END $$;

DROP TABLE _m344_hdr, _m344_inst, _m344_led;
