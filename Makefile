.PHONY: npm all test

NPM_UP_TO_DATE:=.npm-up-to-date
NODE=node

all: test

npm: $(NPM_UP_TO_DATE)

$(NPM_UP_TO_DATE): package.json
	npm install
	touch $(NPM_UP_TO_DATE)

test: npm
	$(NODE) tests/test-node-unit.js
	$(NODE) tests/test-node.js
