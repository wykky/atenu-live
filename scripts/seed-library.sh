#!/usr/bin/env bash
#
# Seed the curated quiz library on the VPS.
#
# Run from the repo root on the VPS *after* the latest commit is pulled
# and the container is up. It copies every TSV from quizzes/library-seed/
# into the container's /tmp/library-seed/ and runs the JS import script
# once per quiz, with the human-readable metadata for that file.
#
# Idempotent: import-library-quiz.cjs is keyed by slug, so re-running will
# update existing rows in place (preserves created_at, refreshes questions).
#
# Usage on VPS:
#   cd /opt/stack/atenu-live
#   bash scripts/seed-library.sh
#
# Usage locally (for testing against a local DB):
#   ATENU_DB_PATH=./data/atenu.db CONTAINER= bash scripts/seed-library.sh
#

set -euo pipefail

CONTAINER="${CONTAINER-atenu-live}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SEED_DIR="$REPO_ROOT/quizzes/library-seed"

if [[ ! -d "$SEED_DIR" ]]; then
  echo "Seed directory not found: $SEED_DIR" >&2
  exit 1
fi

# When CONTAINER is set, run everything inside the container via docker.
# When empty, run locally (assumes node + better-sqlite3 + ATENU_DB_PATH in scope).
run_node() {
  if [[ -n "$CONTAINER" ]]; then
    # Run with cwd /app so Node can resolve better-sqlite3 from /app/node_modules.
    docker exec -w /app "$CONTAINER" node /app/import-library-quiz.cjs "$@"
  else
    node "$SCRIPT_DIR/import-library-quiz.cjs" "$@"
  fi
}

# Copy TSVs + import script into the container. Production Next.js Docker
# images only ship .next/, public/, and node_modules/ — `scripts/` lives in
# source but isn't in the runtime layer. We drop the .cjs into /app/ (not
# /tmp/) so it sits next to node_modules and `require('better-sqlite3')` works.
if [[ -n "$CONTAINER" ]]; then
  echo "→ Copying TSVs + import script into $CONTAINER ..."
  docker exec "$CONTAINER" rm -rf /tmp/library-seed /app/import-library-quiz.cjs
  docker cp "$SEED_DIR" "$CONTAINER:/tmp/library-seed"
  docker cp "$SCRIPT_DIR/import-library-quiz.cjs" "$CONTAINER:/app/import-library-quiz.cjs"
fi

tsv_path() {
  local name="$1"
  if [[ -n "$CONTAINER" ]]; then
    echo "/tmp/library-seed/$name"
  else
    echo "$SEED_DIR/$name"
  fi
}

# One block per quiz: filename → slug + title + subject/grade + description.
# Add new entries here when more TSVs land in quizzes/library-seed/.

run_node \
  --tsv "$(tsv_path mathematics-g9.tsv)" \
  --slug mathematics-g9-algebra-foundations \
  --title "Mathematics Grade 9 — Algebra Foundations" \
  --subject Mathematics --grade 9 --language en \
  --think 5 --answer 25 \
  --description "Linear equations, expressions, exponents, slopes, and sets — core Grade 9 algebra you'll see throughout ESSLCE."

run_node \
  --tsv "$(tsv_path mathematics-g10.tsv)" \
  --slug mathematics-g10-geometry-basics \
  --title "Mathematics Grade 10 — Geometry Basics" \
  --subject Mathematics --grade 10 --language en \
  --think 5 --answer 25 \
  --description "Angles, triangles, circles, and area — the Grade 10 geometry essentials."

run_node \
  --tsv "$(tsv_path biology-g9.tsv)" \
  --slug biology-g9-intro \
  --title "Biology Grade 9 — Introduction to Life Science" \
  --subject Biology --grade 9 --language en \
  --think 5 --answer 20 \
  --description "Cells, organisms, photosynthesis, respiration, classification — the foundation of all biology."

run_node \
  --tsv "$(tsv_path biology-g11.tsv)" \
  --slug biology-g11-cells-transport \
  --title "Biology Grade 11 — Cells & Transport" \
  --subject Biology --grade 11 --language en \
  --think 5 --answer 25 \
  --description "Cell membrane structure, diffusion, osmosis, active transport, and the major organelles."

run_node \
  --tsv "$(tsv_path chemistry-g10.tsv)" \
  --slug chemistry-g10-atomic-structure \
  --title "Chemistry Grade 10 — Atomic Structure" \
  --subject Chemistry --grade 10 --language en \
  --think 5 --answer 25 \
  --description "Subatomic particles, isotopes, ions, the periodic table, and electron shells."

run_node \
  --tsv "$(tsv_path physics-g10.tsv)" \
  --slug physics-g10-motion-forces \
  --title "Physics Grade 10 — Motion & Forces" \
  --subject Physics --grade 10 --language en \
  --think 5 --answer 25 \
  --description "Speed, velocity, acceleration, Newton's laws, weight, and friction — the mechanics foundation."

run_node \
  --tsv "$(tsv_path geography-g9.tsv)" \
  --slug geography-g9-world-geography \
  --title "Geography Grade 9 — World Geography" \
  --subject Geography --grade 9 --language en \
  --think 5 --answer 20 \
  --description "Continents, oceans, latitude and longitude, atmosphere, and Ethiopia's place in the world."

run_node \
  --tsv "$(tsv_path history-g10.tsv)" \
  --slug history-g10-ethiopian-history \
  --title "History Grade 10 — Ethiopian History" \
  --subject History --grade 10 --language en \
  --think 5 --answer 25 \
  --description "Aksum, the Zagwe dynasty, Lalibela, the Solomonic line, Adwa, and the Italian invasion."

run_node \
  --tsv "$(tsv_path ethiopian-history-g9-12.tsv)" \
  --slug ethiopian-history-g9-12 \
  --title "History Grade 9-12: Ethiopian History (Aksum to the Derg)" \
  --subject History --language en \
  --think 8 --answer 22 \
  --description "Thirty questions across the Ethiopian History arc, from Lucy and Aksum through Lalibela, Adwa, the Italian occupation, and the Derg. Grounded in the FDRE Grade 9-12 History textbooks, with per-question timing tuned for readers."

run_node \
  --tsv "$(tsv_path economics-g11.tsv)" \
  --slug economics-g11-basic-economics \
  --title "Economics Grade 11 — Basic Economics" \
  --subject Economics --grade 11 --language en \
  --think 5 --answer 25 \
  --description "Scarcity, demand and supply, equilibrium, opportunity cost, market structures, GDP, and inflation."

run_node \
  --tsv "$(tsv_path english-g10.tsv)" \
  --slug english-g10-grammar-essentials \
  --title "English Grade 10 — Grammar Essentials" \
  --subject English --grade 10 --language en \
  --think 5 --answer 20 \
  --description "Tenses, parts of speech, prepositions, subject-verb agreement, active vs passive voice."

run_node \
  --tsv "$(tsv_path world-cup-2026.tsv)" \
  --slug world-cup-2026 \
  --title "2026 FIFA World Cup Trivia" \
  --subject "General Knowledge" --language en \
  --think 5 --answer 20 \
  --description "Hosts, results, awards, and records from the 2026 World Cup, where Spain beat Argentina 1-0 in the final. A fun mixed-difficulty round for any crowd."

run_node \
  --tsv "$(tsv_path ethiopian-regions-cities.tsv)" \
  --slug ethiopian-regions-cities \
  --title "Ethiopian Regions and Cities" \
  --subject Geography --language en \
  --think 8 --answer 25 \
  --description "Thirty questions on Ethiopia's current regional states and their cities, updated for the 2021 to 2023 map: Sidama, South West Ethiopia, South Ethiopia, and Central Ethiopia. Match cities to regions and zones, spot the odd one out, and trace routes across the new administrative boundaries."

run_node \
  --tsv "$(tsv_path ethiopian-politics-politicians.tsv)" \
  --slug ethiopian-politics-politicians \
  --title "Ethiopian Politics and Politicians" \
  --subject Civics --language en \
  --think 8 --answer 10 \
  --description "Thirty questions on how Ethiopia is governed and who governs it: the FDRE Constitution, the two federal houses, the National Election Board, and the leaders from Menelik II and Haile Selassie through the Derg to Abiy Ahmed. Fact-checked to 15 August 2026, including the seventh general election."

run_node \
  --tsv "$(tsv_path ethiopian-culture-challenge.tsv)" \
  --slug ethiopian-culture-challenge \
  --title "Ethiopian Culture Challenge" \
  --subject Culture --language en \
  --think 8 --answer 10 \
  --description "Thirty questions on Ethiopian music, art, calendar and heritage: Mulatu Astatke and Ethio-jazz, Afewerk Tekle and Africa Hall, the fidel and the thirteen months, Timkat and Meskel, the Gada system, Fichee-Chambalaalla, Shuwalid and Gifaataa, and the World Heritage sites at Lalibela, Harar Jugol, Tiya, Konso and Aksum. Written in simple English for high-school students."

run_node \
  --tsv "$(tsv_path ethiopian-sport-and-athletes.tsv)" \
  --slug ethiopian-sport-and-athletes \
  --title "Ethiopian Sport and Athletes" \
  --subject Sport --language en \
  --think 8 --answer 10 \
  --description "Thirty questions on Ethiopia's sporting greats: Abebe Bikila barefoot in Rome, Mamo Wolde and Miruts Yifter, Derartu Tulu and Fatuma Roba, Haile Gebrselassie and Kenenisa Bekele, Tirunesh Dibaba and Almaz Ayana, Selemon Barega and Tamirat Tola, plus the 1962 Africa Cup of Nations win and the Great Ethiopian Run. Written in simple English for high-school students."

run_node \
  --tsv "$(tsv_path west-african-capitals.tsv)" \
  --slug west-african-capitals \
  --title "West African Capitals and Cities" \
  --subject Geography --language en \
  --think 8 --answer 10 \
  --description "Thirty questions on the capitals and historic cities of West Africa: Cotonou and Abomey, Yamoussoukro and Grand-Bassam, Zinder and Agadez, Bolama and Bissau, Banjul once Bathurst, Praia and Mindelo in Cabo Verde, Saint-Louis and Dakar, Timbuktu, Gao and Djenne in Mali, Kumasi and Cape Coast in Ghana, Abeokuta, Lokoja and Kano in Nigeria, and the founding of Monrovia, Freetown and Conakry. Written in simple English for high-school students."

run_node \
  --tsv "$(tsv_path east-african-countries.tsv)" \
  --slug east-african-countries \
  --title "East African Countries" \
  --subject Geography --language en \
  --think 8 --answer 10 \
  --description "Thirty questions on the countries of East Africa: the East African Community and its eight Partner States, the union of Tanganyika and Zanzibar, Burundi's capital Gitega and the independence of South Sudan, the Battle of Adwa and the Aksumite port of Adulis, Kilimanjaro, Mount Kenya and the Rwenzori, Lakes Tana, Victoria, Turkana and Assal, and the World Heritage sites at Lalibela, Harar Jugol, Zanzibar's Stone Town, Kilwa Kisiwani, Lamu and Konso. Written in simple English for high-school students."

echo
echo "✓ Library seeded. Visit https://live.atenu.org/library to verify."
