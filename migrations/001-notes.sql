-- v1 → v2: de entradas planas (entries + labels por entry_id) al modelo de
-- notas8 (notas con bloques). Las tablas v1 nunca tuvieron datos reales
-- (solo pruebas ya borradas), así que se tiran sin migrar nada.
-- labels primero: referencia a entries y SQLite no deja tirar la referida.
-- Después de esto, ejecutar schema.sql (npm run db:migrate[:remote]).

DROP TABLE IF EXISTS labels;
DROP TABLE IF EXISTS entries;
