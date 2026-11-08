from django.test import Client


def test_store_releases_are_public_and_never_cached():
    response = Client().get('/api/v1/app-releases')
    assert response.status_code == 200
    assert response['Cache-Control'] == 'no-store'
    releases = response.json()
    assert releases == {'ios': {'version': '1.2.3', 'build': '33'}, 'android': {'version': '1.2.3', 'build': '33'}}
    assert not any('url' in release for release in releases.values())
