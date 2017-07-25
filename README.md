# An automated derpibooru to telegram channel grabber bot

## How?

Copy `docker-compose.yml.sample` to `docker-compose.yml` and fulfill it with _your_ data:
* database name,
* username
* password
* telegram channel name
* your telegram bot token
* etc, etc

After you'll run `docker-compose up` for the first time you need to create mongo admin user, just like that
```
docker-compose exec mongo mongo admin
db.createUser({ user: 'your_mongo_admin_name', pwd: 'your_mongo_admin_password', roles: [ { role: "userAdminAnyDatabase", db: "admin" } ] })
```

And most importantly you should crate your mongo database and user with read'n'write permissions
```
docker-compose exec mongo mongo admin -u your_mongo_admin_name -p your_mongo_admin_password
use your_mongo_database_name;
db.createUser({ user: 'your_mongo_user', pwd: 'your_mongo_user', roles:['readWrite']});
```

After that all you need it to relaunch `docker-compose up` and voila, your channel is being fulfilled with pictures of cute and little adorable ponies.