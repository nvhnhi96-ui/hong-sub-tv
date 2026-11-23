#!/usr/bin/env python3
"""Fill the Hóng Sub App Store page through the App Store Connect API (run by .github/workflows/ios-listing.yml).
Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8. Reads metadata.json and screenshots/ next to this file.
Each step logs OK or the error and goes on, so one refusal does not stop the rest.
Usage: listing.py [--attach-build]"""
import hashlib, json, os, pathlib, sys, time
import jwt, requests

HERE = pathlib.Path(__file__).resolve().parent
M = json.loads((HERE / 'metadata.json').read_text(encoding='utf-8'))
KEY = os.environ['ASC_KEY_P8']
BASE = 'https://api.appstoreconnect.apple.com'
FAILS = []


def tok():
    now = int(time.time())
    return jwt.encode({'iss': os.environ['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 1100, 'aud': 'appstoreconnect-v1'},
                      KEY, algorithm='ES256', headers={'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'})


def call(method, path, body=None, params=None, quiet=False):
    r = requests.request(method, BASE + path, params=params, json=body,
                         headers={'Authorization': 'Bearer ' + tok(), 'Content-Type': 'application/json'})
    if r.status_code >= 400:
        if not quiet:
            print('   !! %s %s -> %s %s' % (method, path, r.status_code, r.text[:900]))
        raise RuntimeError(r.status_code)
    return r.json() if r.text else {}


def step(name, fn):
    print('==', name)
    try:
        fn()
        print('   OK')
    except Exception as e:
        FAILS.append(name)
        print('   FAILED', e)


app = call('GET', '/v1/apps', params={'filter[bundleId]': M['bundleId']})['data'][0]
APP = app['id']
print('app', APP, app['attributes']['name'])
LOC = M['locale']


def app_info():
    infos = call('GET', '/v1/apps/%s/appInfos' % APP)['data']
    return [i for i in infos if i['attributes'].get('appStoreState') not in ('READY_FOR_SALE', 'READY_FOR_DISTRIBUTION')][0]


def do_categories():
    info = app_info()
    call('PATCH', '/v1/appInfos/' + info['id'], {'data': {'type': 'appInfos', 'id': info['id'], 'relationships': {
        'primaryCategory': {'data': {'type': 'appCategories', 'id': M['primaryCategory']}},
        'secondaryCategory': {'data': {'type': 'appCategories', 'id': M['secondaryCategory']}}}}})


def do_info_loc():
    info = app_info()
    locs = call('GET', '/v1/appInfos/%s/appInfoLocalizations' % info['id'])['data']
    attrs = {'name': M['name'], 'subtitle': M['subtitle'], 'privacyPolicyUrl': M['privacyPolicyUrl']}
    mine = [l for l in locs if l['attributes']['locale'] == LOC]
    if mine:
        call('PATCH', '/v1/appInfoLocalizations/' + mine[0]['id'], {'data': {'type': 'appInfoLocalizations', 'id': mine[0]['id'], 'attributes': attrs}})
    else:
        attrs['locale'] = LOC
        call('POST', '/v1/appInfoLocalizations', {'data': {'type': 'appInfoLocalizations', 'attributes': attrs,
             'relationships': {'appInfo': {'data': {'type': 'appInfos', 'id': info['id']}}}}})


def do_age():
    """every question answered "no / none". The list of questions grows over time: take it from the declaration itself,
    try "NONE" for the level questions and False for the yes/no ones, and swap the type of any answer Apple refuses."""
    info = app_info()
    ard = call('GET', '/v1/appInfos/%s/ageRatingDeclaration' % info['id'])['data']
    print('   questions:', json.dumps(ard['attributes'], ensure_ascii=False))
    levels = {'alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'horrorOrFearThemes',
              'matureOrSuggestiveThemes', 'medicalOrTreatmentInformation', 'profanityOrCrudeHumor',
              'sexualContentGraphicAndNudity', 'sexualContentOrNudity', 'violenceCartoonOrFantasy', 'violenceRealistic',
              'violenceRealisticProlongedGraphicOrSadistic', 'gunsOrOtherWeapons'}
    skip = {'kidsAgeBand', 'ageRatingOverride', 'ageRatingOverrideV2', 'koreaAgeRatingOverride', 'developerAgeRatingInfoUrl', 'gracRatingClassificationNumber'}
    attrs = {}
    for k, v in ard['attributes'].items():
        if k in skip: continue
        if isinstance(v, bool) or (v is None and k not in levels): attrs[k] = False
        else: attrs[k] = 'NONE'
    for _ in range(8):
        r = requests.patch(BASE + '/v1/ageRatingDeclarations/' + ard['id'], headers={'Authorization': 'Bearer ' + tok(), 'Content-Type': 'application/json'},
                           json={'data': {'type': 'ageRatingDeclarations', 'id': ard['id'], 'attributes': attrs}})
        if r.status_code < 400:
            return
        errs = r.json().get('errors', [])
        print('   retry:', [(e.get('source', {}).get('pointer'), e.get('detail', '')[:120]) for e in errs])
        changed = False
        for e in errs:
            k = (e.get('source') or {}).get('pointer', '').split('/')[-1]
            if not k: continue
            if k not in attrs: attrs[k] = 'NONE' if k in levels else False; changed = True
            elif 'REQUIRED' not in e.get('code', ''):
                attrs[k] = False if attrs[k] == 'NONE' else 'NONE'; changed = True
        if not changed: break
    raise RuntimeError('age rating not accepted')


def version():
    vs = call('GET', '/v1/apps/%s/appStoreVersions' % APP, params={'filter[platform]': 'IOS'})['data']
    vs = [v for v in vs if v['attributes']['appStoreState'] in ('PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED')]
    return vs[0]


def do_version():
    v = version()
    call('PATCH', '/v1/appStoreVersions/' + v['id'], {'data': {'type': 'appStoreVersions', 'id': v['id'],
         'attributes': {'versionString': M.get('version', '1.0.0'), 'copyright': M['copyright']}}})


def version_loc():
    v = version()
    locs = call('GET', '/v1/appStoreVersions/%s/appStoreVersionLocalizations' % v['id'])['data']
    mine = [l for l in locs if l['attributes']['locale'] == LOC]
    attrs = {k: M[k] for k in ('description', 'keywords', 'promotionalText', 'supportUrl', 'marketingUrl')}
    if mine:
        call('PATCH', '/v1/appStoreVersionLocalizations/' + mine[0]['id'], {'data': {'type': 'appStoreVersionLocalizations', 'id': mine[0]['id'], 'attributes': attrs}})
        return mine[0]['id']
    attrs['locale'] = LOC
    return call('POST', '/v1/appStoreVersionLocalizations', {'data': {'type': 'appStoreVersionLocalizations', 'attributes': attrs,
                'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': v['id']}}}}})['data']['id']


def do_screenshots():
    lid = version_loc()
    sets = call('GET', '/v1/appStoreVersionLocalizations/%s/appScreenshotSets' % lid)['data']
    for disp, prefix in (('APP_IPHONE_67', 'iphone'), ('APP_IPAD_PRO_3GEN_129', 'ipad')):
        s = [x for x in sets if x['attributes']['screenshotDisplayType'] == disp]
        if s:
            sid = s[0]['id']
            for old in call('GET', '/v1/appScreenshotSets/%s/appScreenshots' % sid)['data']:
                call('DELETE', '/v1/appScreenshots/' + old['id'])
        else:
            sid = call('POST', '/v1/appScreenshotSets', {'data': {'type': 'appScreenshotSets', 'attributes': {'screenshotDisplayType': disp},
                       'relationships': {'appStoreVersionLocalization': {'data': {'type': 'appStoreVersionLocalizations', 'id': lid}}}}})['data']['id']
        for f in sorted((HERE / 'screenshots').glob(prefix + '-*.png')):
            data = f.read_bytes()
            sc = call('POST', '/v1/appScreenshots', {'data': {'type': 'appScreenshots', 'attributes': {'fileName': f.name, 'fileSize': len(data)},
                      'relationships': {'appScreenshotSet': {'data': {'type': 'appScreenshotSets', 'id': sid}}}}})['data']
            for op in sc['attributes']['uploadOperations']:
                part = data[op['offset']:op['offset'] + op['length']]
                h = {x['name']: x['value'] for x in op['requestHeaders']}
                r = requests.request(op['method'], op['url'], data=part, headers=h)
                r.raise_for_status()
            call('PATCH', '/v1/appScreenshots/' + sc['id'], {'data': {'type': 'appScreenshots', 'id': sc['id'],
                 'attributes': {'uploaded': True, 'sourceFileChecksum': hashlib.md5(data).hexdigest()}}})
            print('   uploaded', disp, f.name)


def do_review():
    v = version()
    attrs = dict(M['review']); attrs['demoAccountRequired'] = False
    try:
        d = call('GET', '/v1/appStoreVersions/%s/appStoreReviewDetail' % v['id'], quiet=True)['data']
    except Exception:
        d = None
    if d:
        call('PATCH', '/v1/appStoreReviewDetails/' + d['id'], {'data': {'type': 'appStoreReviewDetails', 'id': d['id'], 'attributes': attrs}})
    else:
        call('POST', '/v1/appStoreReviewDetails', {'data': {'type': 'appStoreReviewDetails', 'attributes': attrs,
             'relationships': {'appStoreVersion': {'data': {'type': 'appStoreVersions', 'id': v['id']}}}}})


def do_price():
    pts = call('GET', '/v1/apps/%s/appPricePoints' % APP, params={'filter[territory]': 'USA', 'limit': 200})['data']
    free = [p for p in pts if float(p['attributes']['customerPrice']) == 0][0]
    call('POST', '/v1/appPriceSchedules', {'data': {'type': 'appPriceSchedules', 'relationships': {
        'app': {'data': {'type': 'apps', 'id': APP}},
        'baseTerritory': {'data': {'type': 'territories', 'id': 'USA'}},
        'manualPrices': {'data': [{'type': 'appPrices', 'id': '${price1}'}]}}},
        'included': [{'type': 'appPrices', 'id': '${price1}', 'attributes': {'startDate': None},
                      'relationships': {'appPricePoint': {'data': {'type': 'appPricePoints', 'id': free['id']}}}}]})


def do_availability():
    terr = []
    url = '/v1/territories'
    params = {'limit': 200}
    terr = [t['id'] for t in call('GET', url, params=params)['data']]
    inc = [{'type': 'territoryAvailabilities', 'id': '${t%d}' % i, 'attributes': {'available': True},
            'relationships': {'territory': {'data': {'type': 'territories', 'id': t}}}} for i, t in enumerate(terr)]
    call('POST', '/v2/appAvailabilities', {'data': {'type': 'appAvailabilities', 'attributes': {'availableInNewTerritories': True},
         'relationships': {'app': {'data': {'type': 'apps', 'id': APP}},
                           'territoryAvailabilities': {'data': [{'type': 'territoryAvailabilities', 'id': x['id']} for x in inc]}}},
         'included': inc})


def do_no_china():
    """not sold in mainland China: it needs a security assessment and an AI service filing there"""
    av = call('GET', '/v1/apps/%s/appAvailabilityV2' % APP)['data']
    nxt = '/v2/appAvailabilities/%s/territoryAvailabilities' % av['id']
    params = {'limit': 200, 'include': 'territory'}
    while nxt:
        page = call('GET', nxt, params=params)
        for ta in page['data']:
            tid = ((ta.get('relationships') or {}).get('territory') or {}).get('data', {}).get('id')
            if tid == 'CHN':
                if ta['attributes'].get('available'):
                    call('PATCH', '/v1/territoryAvailabilities/' + ta['id'], {'data': {'type': 'territoryAvailabilities', 'id': ta['id'], 'attributes': {'available': False}}})
                print('   CHN off')
                return
        nl = (page.get('links') or {}).get('next')
        nxt = nl.replace(BASE, '') if nl else None; params = None
    raise RuntimeError('CHN not found')


def latest_build():
    bs = call('GET', '/v1/builds', params={'filter[app]': APP, 'sort': '-uploadedDate', 'limit': 5})['data']
    return [b for b in bs if b['attributes']['processingState'] == 'VALID'][0]


def upsert(list_path, create_type, rel_name, rel_type, rel_id, attrs, match=None):
    items = call('GET', list_path)['data']
    if match: items = [i for i in items if all(i['attributes'].get(k) == v for k, v in match.items())]
    if items:
        a = {k: v for k, v in attrs.items() if k != 'locale'}
        call('PATCH', '/v1/%s/%s' % (create_type, items[0]['id']), {'data': {'type': create_type, 'id': items[0]['id'], 'attributes': a}})
        return items[0]['id']
    return call('POST', '/v1/' + create_type, {'data': {'type': create_type, 'attributes': attrs,
                'relationships': {rel_name: {'data': {'type': rel_type, 'id': rel_id}}}}})['data']['id']


def do_testflight():
    """TestFlight for customers: an external group with a public link, the newest build in it, sent to Beta App Review"""
    T = M['testflight']
    for loc in ('vi', 'en-US'):
        try:
            upsert('/v1/apps/%s/betaAppLocalizations' % APP, 'betaAppLocalizations', 'app', 'apps', APP,
                   {'locale': loc, 'description': T['description'], 'feedbackEmail': M['review']['contactEmail'],
                    'marketingUrl': M['marketingUrl'], 'privacyPolicyUrl': M['privacyPolicyUrl']}, match={'locale': loc})
            print('   beta info', loc)
        except Exception as e:
            print('   beta info', loc, 'skipped', e)
    d = call('GET', '/v1/apps/%s/betaAppReviewDetail' % APP)['data']
    r = M['review']
    call('PATCH', '/v1/betaAppReviewDetails/' + d['id'], {'data': {'type': 'betaAppReviewDetails', 'id': d['id'], 'attributes': {
        'contactFirstName': r['contactFirstName'], 'contactLastName': r['contactLastName'], 'contactPhone': r['contactPhone'],
        'contactEmail': r['contactEmail'], 'demoAccountRequired': False, 'notes': r['notes']}}})
    b = latest_build()
    print('   build', b['attributes']['version'])
    for loc in ('vi', 'en-US'):
        try:
            upsert('/v1/builds/%s/betaBuildLocalizations' % b['id'], 'betaBuildLocalizations', 'build', 'builds', b['id'],
                   {'locale': loc, 'whatsNew': T['whatsNew']}, match={'locale': loc})
        except Exception as e:
            print('   what to test', loc, 'skipped', e)
    groups = [g for g in call('GET', '/v1/apps/%s/betaGroups' % APP)['data'] if g['attributes']['name'] == T['group']]
    if groups:
        gid = groups[0]['id']
    else:
        gid = call('POST', '/v1/betaGroups', {'data': {'type': 'betaGroups', 'attributes': {'name': T['group'], 'feedbackEnabled': True},
                   'relationships': {'app': {'data': {'type': 'apps', 'id': APP}}}}})['data']['id']
    call('POST', '/v1/betaGroups/%s/relationships/builds' % gid, {'data': [{'type': 'builds', 'id': b['id']}]})
    try:
        call('POST', '/v1/betaAppReviewSubmissions', {'data': {'type': 'betaAppReviewSubmissions',
             'relationships': {'build': {'data': {'type': 'builds', 'id': b['id']}}}}})
        print('   sent to Beta App Review')
    except Exception as e:
        print('   beta review: already sent or not needed', e)
    try:
        call('PATCH', '/v1/betaGroups/' + gid, {'data': {'type': 'betaGroups', 'id': gid, 'attributes': {
             'publicLinkEnabled': True, 'publicLinkLimitEnabled': True, 'publicLinkLimit': 10000}}})
    except Exception as e:
        print('   public link not yet', e)
    g = call('GET', '/v1/betaGroups/' + gid)['data']['attributes']
    sub = call('GET', '/v1/builds/%s/buildBetaDetail' % b['id'])['data']['attributes']
    print('   GROUP', json.dumps({k: g.get(k) for k in ('name', 'publicLinkEnabled', 'publicLink', 'publicLinkLimit')}))
    print('   BETA STATE', json.dumps(sub))


def do_build():
    v = version()
    for i in range(40):
        bs = call('GET', '/v1/builds', params={'filter[app]': APP, 'sort': '-uploadedDate', 'limit': 5})['data']
        ok = [b for b in bs if b['attributes']['processingState'] == 'VALID']
        if ok:
            b = ok[0]
            call('PATCH', '/v1/appStoreVersions/%s/relationships/build' % v['id'], {'data': {'type': 'builds', 'id': b['id']}})
            print('   build', b['attributes']['version'], 'attached')
            return
        print('   build still processing:', [x['attributes']['processingState'] for x in bs])
        time.sleep(30)
    raise RuntimeError('no processed build yet')


ONLY = [a for a in sys.argv[1:] if not a.startswith('--')]
if ONLY:
    for n in ONLY: step(n, globals()[n])
    print('\nLỗi ở:', FAILS if FAILS else 'không có'); sys.exit(0)
step('Danh mục app', do_categories)
step('Tên, phụ đề, chính sách quyền riêng tư', do_info_loc)
step('Độ tuổi', do_age)
step('Phiên bản, bản quyền', do_version)
step('Mô tả, từ khóa', lambda: version_loc())
step('Ảnh màn hình', do_screenshots)
step('Thông tin cho người duyệt', do_review)
step('Giá: miễn phí', do_price)
step('Quốc gia bán', do_availability)
step('Không bán ở Trung Quốc đại lục', do_no_china)
if '--attach-build' in sys.argv:
    step('Gắn bản dựng', do_build)
print('\nLỗi ở:', FAILS if FAILS else 'không có')
