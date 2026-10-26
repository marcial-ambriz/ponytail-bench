# CP2 Stock
R2.1 GET /total returns {"total": sum of qty}. R2.2 POST /items/<id>/take {qty} decrements stock.
R2.3 Taking more than available returns 409 and never makes stock negative, also under concurrency.
