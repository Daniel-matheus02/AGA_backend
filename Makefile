.PHONY: up down dev migrate seed test build
up:
	docker compose up -d postgres redis

down:
	docker compose down

dev:
	npm run start:dev

migrate:
	npm run prisma:migrate -- --name init

seed:
	npm run prisma:seed

test:
	npm test

build:
	npm run build
