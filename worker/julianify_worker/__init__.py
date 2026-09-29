"""Worker di calcolo di Julianify.

Due lavori pesanti che il server Node delega a Python:

* ``stems``: separazione degli strumenti con Demucs (htdemucs_6s) e creazione
  di versioni della registrazione senza chitarra, solo chitarra, ecc.;
* ``autosync``: allineamento automatico spartito-registrazione con Sync Toolbox
  (chroma + attacchi, MrMsDTW), da cui nascono i sync point.

Il server avvia ``python -m julianify_worker <comando>``, scrive i parametri
JSON su stdin e legge da stdout un messaggio JSON per riga (vedi ``protocol``).
"""

__version__ = '1.0.0'
