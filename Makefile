.PHONY: up down db logs reset

up:      ## start postgres
	docker compose up -d

down:    ## stop postgres (keeps data)
	docker compose down

reset:   ## stop postgres and DELETE all data
	docker compose down -v && docker compose up -d

logs:
	docker compose logs -f db

db:      ## open a psql shell
	docker exec -it booking_db psql -U booking -d booking

migrate: ## apply db/*.sql migrations
	npm run migrate

seed:    ## insert sample rooms
	npm run seed

dev:     ## run the API with hot reload
	npm run dev

loadtest: ## fire 500 concurrent requests at one slot
	npm run loadtest
