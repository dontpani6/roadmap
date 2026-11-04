# Запуск Вех бесплатно на Oracle Cloud

Около 20 минут. Понадобятся карта Visa или Mastercard (только для проверки, деньги не списываются) и компьютер с терминалом (на Windows подойдёт PowerShell).

## 1. Регистрация

1. Откройте [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) и нажмите «Start for free».
2. Страна: **Ukraine**. Домашний регион (Home Region) выберите **Germany Central (Frankfurt)** или **Switzerland North (Zurich)**. Поменять его потом нельзя, а бесплатный сервер создаётся только в домашнем регионе.
3. Подтвердите карту. Временная блокировка в 1 доллар потом снимается.

## 2. Создание сервера

1. В меню: **Compute → Instances → Create instance**.
2. Name: `vehi`.
3. **Image and shape → Edit**:
   - Image: **Change image → Ubuntu → Canonical Ubuntu 24.04**.
   - Shape: **Change shape → Ampere → VM.Standard.A1.Flex**, 2 OCPU и 12 GB памяти (рядом должна быть метка «Always Free-eligible»).
4. **Networking**: оставьте «Create new virtual cloud network» и «Assign a public IPv4 address».
5. **Add SSH keys**: «Generate a key pair for me» и нажмите **Save private key**. Сохраните файл, без него на сервер не зайти.
6. Нажмите **Create**. Через минуту-две статус станет «Running». Скопируйте **Public IP address**.

> Если пишет **Out of capacity**, свободных серверов сейчас нет. Попробуйте другой Availability Domain в том же окне или повторите через несколько часов. Многим помогает перевод аккаунта на Pay As You Go (Billing → Upgrade): бесплатные ресурсы остаются бесплатными, но лучше сразу поставить бюджет-оповещение на 1 доллар.

## 3. Открыть порты 80 и 443

1. На странице сервера нажмите на ссылку **Subnet** (раздел Primary VNIC).
2. **Security Lists → Default Security List → Add Ingress Rules**.
3. Source CIDR `0.0.0.0/0`, IP Protocol `TCP`, Destination Port Range `80,443`. Нажмите **Add**.

## 4. Бесплатный адрес

1. Зайдите на [duckdns.org](https://www.duckdns.org) через Google или GitHub.
2. Придумайте поддомен, например `vehi-team`, и нажмите **add domain**.
3. В поле **current ip** вставьте Public IP сервера и нажмите **update ip**.

Ваш адрес: `vehi-team.duckdns.org`.

## 5. Установка

В PowerShell (Windows) или терминале (macOS, Linux):

```bash
ssh -i путь/к/ssh-key.key ubuntu@PUBLIC_IP
```

На macOS и Linux перед этим выполните `chmod 600 путь/к/ssh-key.key`. На вопрос про fingerprint ответьте `yes`.

На сервере:

```bash
curl -fsSL https://raw.githubusercontent.com/dontpani6/roadmap/main/deploy/install.sh | sudo bash -s -- vehi-team.duckdns.org
```

Через 2–3 минуты скрипт напишет «Готово».

## 6. Первый вход

1. Откройте `https://vehi-team.duckdns.org` и зарегистрируйтесь. Первый пользователь становится администратором.
2. **Настройки → Команда → Создать приглашение** и отправьте ссылки коллегам.
3. **Настройки → ИИ и API → Создать токен**, затем «Копировать URL для Claude» и добавьте его в Claude: Настройки → Коннекторы → Добавить свой коннектор.

Обновления ставятся сами каждые 5 минут, резервная копия данных делается каждую ночь в `/opt/roadmap/backups`.
